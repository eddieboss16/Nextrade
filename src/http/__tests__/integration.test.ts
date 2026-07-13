import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, type App } from '../../app';
import { withTransaction, type Db } from '../../db/persistence';

const schema = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8');

let pg: PGlite;
let db: Db;

function asDb(p: PGlite): Db {
  return {
    query: (sql, params) => p.query(sql, params),
    transaction: (fn) => withTransaction(p, fn),
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(schema);
  db = asDb(pg);
});

beforeEach(async () => {
  await pg.exec(
    `TRUNCATE ledger_entries, trades, orders, accounts, instruments RESTART IDENTITY CASCADE;`,
  );
  await pg.exec(`
    INSERT INTO instruments (id, symbol, name) VALUES ('AAA','AAA','Alpha'), ('BBB','BBB','Beta');
    INSERT INTO accounts (id, name) VALUES ('ACC1','One'), ('ACC2','Two');
  `);
});

afterAll(async () => {
  await pg.close();
});

// Mirror Laravel's "persist the order as pending before forwarding" step.
async function seedPending(o: {
  id: string;
  instrumentId: string;
  accountId: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  sequence: number;
}): Promise<void> {
  await pg.query(
    `INSERT INTO orders (id, instrument_id, account_id, side, type, price, quantity, status, sequence)
     VALUES ($1,$2,$3,$4,'limit',$5,$6,'pending',$7)`,
    [o.id, o.instrumentId, o.accountId, o.side, o.price, o.quantity, o.sequence],
  );
}

async function withApp(fn: (base: string, app: App) => Promise<void>): Promise<void> {
  const app = createApp({ db });
  const { host, port } = await app.listen(0);
  try {
    await fn(`http://${host}:${port}`, app);
  } finally {
    await app.close();
  }
}

function post(base: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function nextMessage(
  ws: WebSocket,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs);
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

describe('internal HTTP + WS integration', () => {
  it('#1 a valid order submitted over HTTP produces the expected state on the engine snapshot', async () => {
    await withApp(async (base, app) => {
      await seedPending({ id: 's1', instrumentId: 'AAA', accountId: 'ACC1', side: 'sell', price: 100, quantity: 5, sequence: 1 });
      await seedPending({ id: 'b1', instrumentId: 'AAA', accountId: 'ACC2', side: 'buy', price: 100, quantity: 5, sequence: 2 });

      const r1 = await post(base, '/internal/orders', { id: 's1', instrumentId: 'AAA', accountId: 'ACC1', side: 'sell', type: 'limit', price: 100, quantity: 5 });
      expect(r1.status).toBe(200);
      // Assert against the engine's own snapshot, not just the HTTP response.
      expect(app.engine.getSnapshot('AAA').asks).toEqual([{ price: 100, quantity: 5 }]);

      const r2 = await post(base, '/internal/orders', { id: 'b1', instrumentId: 'AAA', accountId: 'ACC2', side: 'buy', type: 'limit', price: 100, quantity: 5 });
      expect(r2.status).toBe(200);
      // The crossing buy fully matched the resting sell: book is now empty.
      expect(app.engine.getSnapshot('AAA').asks).toEqual([]);
      expect(app.engine.getSnapshot('AAA').bids).toEqual([]);
      // And the trade was persisted: 1 trades row, 2 ledger rows.
      const t = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM trades`);
      const l = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM ledger_entries`);
      expect(t.rows[0]!.c).toBe(1);
      expect(l.rows[0]!.c).toBe(2);
    });
  });

  it('#2 a duplicate order id is rejected (409), not silently accepted twice', async () => {
    await withApp(async (base, app) => {
      await seedPending({ id: 'dup', instrumentId: 'AAA', accountId: 'ACC1', side: 'buy', price: 100, quantity: 5, sequence: 1 });

      const first = await post(base, '/internal/orders', { id: 'dup', instrumentId: 'AAA', accountId: 'ACC1', side: 'buy', type: 'limit', price: 100, quantity: 5 });
      expect(first.status).toBe(200);

      const second = await post(base, '/internal/orders', { id: 'dup', instrumentId: 'AAA', accountId: 'ACC1', side: 'buy', type: 'limit', price: 100, quantity: 5 });
      expect(second.status).toBe(409); // rejected, NOT a silent 200

      // No double-submit: the book still holds only the first order.
      expect(app.engine.getSnapshot('AAA').bids).toEqual([{ price: 100, quantity: 5 }]);
    });
  });

  it('#3 cancel removes the order from the book and flips its Postgres row to cancelled', async () => {
    await withApp(async (base, app) => {
      await seedPending({ id: 'c1', instrumentId: 'AAA', accountId: 'ACC1', side: 'buy', price: 100, quantity: 5, sequence: 1 });
      await post(base, '/internal/orders', { id: 'c1', instrumentId: 'AAA', accountId: 'ACC1', side: 'buy', type: 'limit', price: 100, quantity: 5 });
      expect(app.engine.getSnapshot('AAA').bids).toEqual([{ price: 100, quantity: 5 }]);

      const res = await post(base, '/internal/orders/c1/cancel');
      expect(res.status).toBe(200);

      expect(app.engine.getSnapshot('AAA').bids).toEqual([]); // gone from the book
      const row = await pg.query<{ status: string }>(`SELECT status FROM orders WHERE id='c1'`);
      expect(row.rows[0]!.status).toBe('cancelled'); // Postgres row updated
    });
  });

  it('#6 a subscribed WS client receives a trade print after a matching order is submitted', async () => {
    await withApp(async (base) => {
      const wsUrl = base.replace('http', 'ws');
      const client = new WebSocket(`${wsUrl}/stream/AAA`);
      await open(client);
      const gotTrade = nextMessage(client, (m) => m.type === 'trade');

      await seedPending({ id: 's1', instrumentId: 'AAA', accountId: 'ACC1', side: 'sell', price: 100, quantity: 5, sequence: 1 });
      await seedPending({ id: 'b1', instrumentId: 'AAA', accountId: 'ACC2', side: 'buy', price: 100, quantity: 5, sequence: 2 });
      await post(base, '/internal/orders', { id: 's1', instrumentId: 'AAA', accountId: 'ACC1', side: 'sell', type: 'limit', price: 100, quantity: 5 });
      await post(base, '/internal/orders', { id: 'b1', instrumentId: 'AAA', accountId: 'ACC2', side: 'buy', type: 'limit', price: 100, quantity: 5 });

      const trade = await gotTrade;
      expect(trade.instrumentId).toBe('AAA');
      expect(trade.price).toBe(100);
      expect(trade.quantity).toBe(5);
      client.close();
    });
  });

  it('#7 a client subscribed to one instrument does not receive another instrument\'s events', async () => {
    await withApp(async (base) => {
      const wsUrl = base.replace('http', 'ws');
      const clientA = new WebSocket(`${wsUrl}/stream/AAA`);
      await open(clientA);
      const received: Record<string, unknown>[] = [];
      clientA.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));

      // A trade happens entirely on BBB.
      await seedPending({ id: 's1', instrumentId: 'BBB', accountId: 'ACC1', side: 'sell', price: 50, quantity: 5, sequence: 1 });
      await seedPending({ id: 'b1', instrumentId: 'BBB', accountId: 'ACC2', side: 'buy', price: 50, quantity: 5, sequence: 2 });
      await post(base, '/internal/orders', { id: 's1', instrumentId: 'BBB', accountId: 'ACC1', side: 'sell', type: 'limit', price: 50, quantity: 5 });
      await post(base, '/internal/orders', { id: 'b1', instrumentId: 'BBB', accountId: 'ACC2', side: 'buy', type: 'limit', price: 50, quantity: 5 });

      // Give any (erroneous) cross-instrument broadcast time to arrive.
      await new Promise((r) => setTimeout(r, 150));
      expect(received).toEqual([]); // client on AAA saw nothing for BBB
      clientA.close();
    });
  });

  it('binds explicitly to 127.0.0.1, not 0.0.0.0', async () => {
    const app = createApp({ db });
    await app.listen(0);
    try {
      const addr = app.server.address() as AddressInfo;
      expect(addr.address).toBe('127.0.0.1');
    } finally {
      await app.close();
    }
  });
});
