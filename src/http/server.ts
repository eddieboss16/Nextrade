// Week 2 internal HTTP surface.
//
// Raw Node http server (no Express/Fastify) exposing two endpoints for Laravel
// to call over the loopback interface only:
//   POST /internal/orders             submit a new order
//   POST /internal/orders/:id/cancel  cancel an existing order
//
// THE ONE RULE (spec): between parsing the request body and calling
// engine.submitOrder()/cancelOrder() there must be NO `await`. Any async work
// there reopens a check-then-act race between concurrent requests that the
// single-threaded engine design exists to prevent. Async work happens either
// before parsing (reading the body) or after the synchronous engine call
// returns (persistence). The no-await zones below are marked explicitly.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import type { MatchingEngine } from '../engine/matchingEngine';
import type { SubmitOrderInput, EngineEvent } from '../engine/types';
import { persistEvents, type Db } from '../db/persistence';

export interface AppDeps {
  engine: MatchingEngine;
  db: Db;
  broadcast: (events: EngineEvent[]) => void;
}

export function createHttpServer(deps: AppDeps): Server {
  return createServer((req, res) => {
    void handle(deps, req, res);
  });
}

async function handle(
  deps: AppDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';

  if (method === 'POST' && url.pathname === '/internal/orders') {
    const raw = await readBody(req); // async, BEFORE parsing — allowed
    let input: SubmitOrderInput;
    try {
      input = JSON.parse(raw) as SubmitOrderInput; // synchronous parse
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    // ─── NO `await` FROM HERE UNTIL submitOrder() HAS RETURNED ───────────────
    const events = deps.engine.submitOrder(input);
    // ─── end no-await zone ───────────────────────────────────────────────────
    deps.broadcast(events); // synchronous fan-out, fire-and-forget
    await persistEvents(deps.db, events); // after the engine call; never throws
    respondForSubmit(res, events);
    return;
  }

  const cancel = url.pathname.match(/^\/internal\/orders\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    const orderId = decodeURIComponent(cancel[1]);
    await drain(req); // async, BEFORE the engine call — allowed
    // ─── NO `await` FROM HERE UNTIL cancelOrder() HAS RETURNED ───────────────
    const events = deps.engine.cancelOrder(orderId);
    // ─── end no-await zone ───────────────────────────────────────────────────
    deps.broadcast(events);
    await persistEvents(deps.db, events);
    if (events.length === 0) {
      sendJson(res, 404, { error: 'order not found or not cancellable', orderId });
      return;
    }
    sendJson(res, 200, { ok: true, events });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// Only a duplicate id is elevated to a non-2xx error — that is the one case the
// spec requires not be a silent 200 ("defense against a duplicate forward").
// Any other outcome (rest, fill, partial) returns 200 with the events.
function respondForSubmit(res: ServerResponse, events: EngineEvent[]): void {
  const duplicate = events.find(
    (e) => e.type === 'order_rejected' && /duplicate/i.test(e.reason),
  );
  if (duplicate) {
    sendJson(res, 409, { error: 'duplicate order id', events });
    return;
  }
  sendJson(res, 200, { ok: true, events });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('data', () => {});
    req.on('end', () => resolve());
    req.on('error', () => resolve());
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
