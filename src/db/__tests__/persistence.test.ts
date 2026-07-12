import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MatchingEngine } from '../../engine/matchingEngine';
import { persistEvents, withTransaction, type Db, type PersistLogger } from '../persistence';
import { readNextSequence } from '../bootstrap';
import type { EngineEvent, Trade } from '../../engine/types';

const schema = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8');

// One in-process Postgres for the whole file — booting a fresh pglite (WASM) per
// test is slow. Data is reset before each test with TRUNCATE (which the
// append-only trigger permits: it only fires on row UPDATE/DELETE).
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(schema);
});

beforeEach(async () => {
  await db.exec(
    `TRUNCATE ledger_entries, trades, orders, accounts, instruments RESTART IDENTITY CASCADE;`,
  );
});

afterAll(async () => {
  await db.close();
});

async function seedInstrumentAndAccounts(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO instruments (id, symbol, name) VALUES ('AAPL', 'AAPL', 'Apple Inc.');
    INSERT INTO accounts (id, name) VALUES ('SELLER', 'Seller'), ('BUYER', 'Buyer');
  `);
}

// Mirror Laravel's "persist the order as pending before forwarding" step.
async function insertPendingOrder(
  db: PGlite,
  o: {
    id: string;
    accountId: string;
    side: 'buy' | 'sell';
    type: 'limit' | 'market';
    price: number | null;
    quantity: number;
    sequence: number;
  },
): Promise<void> {
  // Insert as 'pending' — exactly the status Laravel writes before forwarding.
  await db.query(
    `INSERT INTO orders
       (id, instrument_id, account_id, side, type, price, quantity, filled_quantity, status, sequence)
     VALUES ($1, 'AAPL', $2, $3, $4, $5, $6, 0, 'pending', $7)`,
    [o.id, o.accountId, o.side, o.type, o.price, o.quantity, o.sequence],
  );
}

function tradesOf(events: EngineEvent[]): Trade[] {
  return events.flatMap((e) => (e.type === 'trade' ? [e.trade] : []));
}

function capturingLogger(): { errors: string[]; logger: PersistLogger } {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      error: (m, e) => errors.push(`${m} :: ${e instanceof Error ? e.message : String(e)}`),
    },
  };
}

// A Db backed by real pglite. pglite is a single connection, so running
// BEGIN/COMMIT/ROLLBACK through withTransaction on it is safe.
function asDb(pg: PGlite): Db {
  return {
    query: (sql, params) => pg.query(sql, params),
    transaction: (fn) => withTransaction(pg, fn),
  };
}

// Same, except the ledger_entries INSERT (the 2nd write inside the trade
// transaction) fails. Everything else — BEGIN, the trades INSERT, ROLLBACK —
// runs against real pglite, so we can observe that the trade insert is undone.
function failOnLedgerInsert(pg: PGlite): Db {
  const query = (sql: string, params?: unknown[]) => {
    if (/insert into ledger_entries/i.test(sql)) {
      return Promise.reject(
        new Error('simulated failure on the ledger insert (2nd write in the trade tx)'),
      );
    }
    return pg.query(sql, params);
  };
  return { query, transaction: (fn) => withTransaction({ query }, fn) };
}

// --- Required test #4 ------------------------------------------------------
describe('persistEvents — trade fan-out (required test #4)', () => {
  it('a trade writes exactly one trades row and exactly two ledger_entries rows (one per side)', async () => {
    await seedInstrumentAndAccounts(db);

    const engine = new MatchingEngine();
    const e1 = engine.submitOrder({ instrumentId: 'AAPL', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5 }); // order-1
    const e2 = engine.submitOrder({ instrumentId: 'AAPL', accountId: 'BUYER',  side: 'buy',  type: 'limit', price: 100, quantity: 5 }); // order-2 crosses

    // Laravel would already have inserted both order rows before forwarding.
    await insertPendingOrder(db, { id: 'order-1', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5, sequence: 1 });
    await insertPendingOrder(db, { id: 'order-2', accountId: 'BUYER',  side: 'buy',  type: 'limit', price: 100, quantity: 5, sequence: 2 });

    await persistEvents(asDb(db), [...e1, ...e2]);

    const trades = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM trades`);
    const ledger = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ledger_entries`);
    expect(trades.rows[0]!.c).toBe(1);
    expect(ledger.rows[0]!.c).toBe(2);

    const sides = await db.query<{ account_id: string; side: string; quantity: number; price: number }>(
      `SELECT account_id, side, quantity::int AS quantity, price::int AS price FROM ledger_entries ORDER BY side`,
    );
    expect(sides.rows).toEqual([
      { account_id: 'BUYER',  side: 'buy',  quantity: 5, price: 100 },
      { account_id: 'SELLER', side: 'sell', quantity: 5, price: 100 },
    ]);

    // Order rows were updated to filled by the order_filled events.
    const o1 = await db.query<{ status: string; filled_quantity: number }>(
      `SELECT status, filled_quantity::int AS filled_quantity FROM orders WHERE id = 'order-1'`,
    );
    expect(o1.rows[0]).toEqual({ status: 'filled', filled_quantity: 5 });
  });
});

// --- Required test #5 ------------------------------------------------------
describe('persistEvents — Postgres write-failure resilience (required test #5)', () => {
  it('a failed write is logged, not thrown, and the engine still matches on the next call', async () => {
    const brokenDb: Db = {
      query: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432 (simulated broken connection)');
      },
      transaction: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432 (simulated broken connection)');
      },
    };
    const { errors, logger } = capturingLogger();
    const engine = new MatchingEngine();

    // First order rests in memory; persisting it hits the broken DB.
    const e1 = engine.submitOrder({ instrumentId: 'AAPL', accountId: 'S', side: 'sell', type: 'limit', price: 100, quantity: 5 });
    await expect(persistEvents(brokenDb, e1, logger)).resolves.toBeUndefined(); // does NOT throw
    expect(errors.length).toBeGreaterThan(0); // failure WAS logged

    // The in-memory book is untouched by the persistence failure: a crossing
    // order submitted right after must still match correctly.
    const e2 = engine.submitOrder({ instrumentId: 'AAPL', accountId: 'B', side: 'buy', type: 'limit', price: 100, quantity: 5 });
    await expect(persistEvents(brokenDb, e2, logger)).resolves.toBeUndefined();

    const trades = tradesOf(e2);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.price).toBe(100);
    expect(trades[0]!.quantity).toBe(5);
    expect(engine.getSnapshot('AAPL').bids).toEqual([]);
    expect(engine.getSnapshot('AAPL').asks).toEqual([]);
  });
});

// --- Trade + ledger atomicity (the item-3 fix) -----------------------------
describe('persistEvents — trade + ledger atomicity', () => {
  it('rolls back the trade row when the ledger insert fails: zero trades AND zero ledger rows', async () => {
    await seedInstrumentAndAccounts(db);
    const engine = new MatchingEngine();
    const e1 = engine.submitOrder({ instrumentId: 'AAPL', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5 });
    const e2 = engine.submitOrder({ instrumentId: 'AAPL', accountId: 'BUYER',  side: 'buy',  type: 'limit', price: 100, quantity: 5 });
    await insertPendingOrder(db, { id: 'order-1', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5, sequence: 1 });
    await insertPendingOrder(db, { id: 'order-2', accountId: 'BUYER',  side: 'buy',  type: 'limit', price: 100, quantity: 5, sequence: 2 });

    const { errors, logger } = capturingLogger();
    // The trades INSERT would otherwise succeed; only the ledger INSERT fails.
    await persistEvents(failOnLedgerInsert(db), [...e1, ...e2], logger);

    // The failure was logged at the event level (swallow behavior unchanged)...
    expect(errors.some((e) => /ledger insert/i.test(e))).toBe(true);

    // ...and CRUCIALLY the trade insert was rolled back with it — NOT one-and-zero.
    const trades = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM trades`);
    const ledger = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ledger_entries`);
    expect(trades.rows[0]!.c).toBe(0);
    expect(ledger.rows[0]!.c).toBe(0);
  });
});

// --- Schema guard re-exercise (append-only trigger + CHECK constraints) ----
describe('schema guards enforced through the db layer', () => {
  it('blocks UPDATE and DELETE on ledger_entries (append-only trigger)', async () => {
    await seedInstrumentAndAccounts(db);
    await insertPendingOrder(db, { id: 'order-1', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5, sequence: 1 });
    await insertPendingOrder(db, { id: 'order-2', accountId: 'BUYER',  side: 'buy',  type: 'limit', price: 100, quantity: 5, sequence: 2 });
    await db.exec(`INSERT INTO trades (id, instrument_id, buy_order_id, sell_order_id, price, quantity, sequence)
                   VALUES ('trade-1','AAPL','order-2','order-1',100,5,3);`);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO ledger_entries (account_id, instrument_id, trade_id, order_id, side, quantity, price, sequence)
       VALUES ('BUYER','AAPL','trade-1','order-2','buy',5,100,3) RETURNING id`,
    );
    const id = ins.rows[0]!.id;

    await expect(db.query(`UPDATE ledger_entries SET quantity = 999 WHERE id = ${id}`)).rejects.toThrow(
      /append-only/i,
    );
    await expect(db.query(`DELETE FROM ledger_entries WHERE id = ${id}`)).rejects.toThrow(/append-only/i);
  });

  it('rejects a limit order with NULL price and a market order with non-null price (CHECK)', async () => {
    await seedInstrumentAndAccounts(db);
    await expect(
      db.query(`INSERT INTO orders (id, instrument_id, account_id, side, type, price, quantity, status, sequence)
                VALUES ('bad-limit','AAPL','BUYER','buy','limit',NULL,5,'open',1)`),
    ).rejects.toThrow(/orders_price_matches_type/);
    await expect(
      db.query(`INSERT INTO orders (id, instrument_id, account_id, side, type, price, quantity, status, sequence)
                VALUES ('bad-market','AAPL','BUYER','buy','market',100,5,'open',2)`),
    ).rejects.toThrow(/orders_price_matches_type/);
  });

  it('rejects a trade whose buy_order_id equals sell_order_id (CHECK)', async () => {
    await seedInstrumentAndAccounts(db);
    await insertPendingOrder(db, { id: 'order-1', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5, sequence: 1 });
    await expect(
      db.query(`INSERT INTO trades (id, instrument_id, buy_order_id, sell_order_id, price, quantity, sequence)
                VALUES ('bad-trade','AAPL','order-1','order-1',100,5,2)`),
    ).rejects.toThrow(/trades_distinct_orders/);
  });
});

// --- Bootstrap sequence seeding (COALESCE on empty tables) -----------------
describe('readNextSequence — bootstrap seeding', () => {
  it('returns 1 on a first-ever startup with empty tables (COALESCE handles NULL)', async () => {
    expect(await readNextSequence(db)).toBe(1);
  });

  it('returns one past the max sequence across BOTH orders and trades', async () => {
    await seedInstrumentAndAccounts(db);
    await insertPendingOrder(db, { id: 'order-1', accountId: 'SELLER', side: 'sell', type: 'limit', price: 100, quantity: 5, sequence: 40 });
    await insertPendingOrder(db, { id: 'order-2', accountId: 'BUYER',  side: 'buy',  type: 'limit', price: 100, quantity: 5, sequence: 41 });
    await db.exec(`INSERT INTO trades (id, instrument_id, buy_order_id, sell_order_id, price, quantity, sequence)
                   VALUES ('trade-1','AAPL','order-2','order-1',100,5,42);`);
    // max is 42 (in trades) -> next is 43
    expect(await readNextSequence(db)).toBe(43);
  });
});
