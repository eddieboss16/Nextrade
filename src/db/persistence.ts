// Week 2 persistence layer — thin wrapper around a Postgres driver, no ORM.
//
// These writes run AFTER a synchronous engine call has already returned; they
// never sit inside submitOrder/cancelOrder and never block the next engine call.
// Every write is independently guarded: a Postgres failure is logged and
// skipped, never thrown. The in-memory order book remains the source of truth
// for matching regardless of persistence state (spec §2, required test #5).
//
// The module depends only on a minimal `Queryable` shape, which both a real
// `pg.Pool`/`pg.Client` and an in-process pglite instance satisfy — so the exact
// same write code is exercised in tests (pglite) and production (pg).

import type { EngineEvent, Trade, Order } from '../engine/types';

/** Minimal surface both `pg` and pglite provide. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * A queryable that can also run a set of writes inside one transaction on a
 * single dedicated connection. `persistEvents` needs this so a trade row and its
 * two ledger rows commit together or not at all.
 */
export interface Db extends Queryable {
  transaction(fn: (tx: Queryable) => Promise<void>): Promise<void>;
}

/** Where persistence failures are reported. Defaults to console.error. */
export interface PersistLogger {
  error(message: string, err: unknown): void;
}

const defaultLogger: PersistLogger = {
  error(message, err) {
    // eslint-disable-next-line no-console
    console.error(message, err);
  },
};

/**
 * Run `fn` inside BEGIN/COMMIT on a single connection, rolling back and
 * rethrowing on any error. `conn` MUST be one dedicated connection (a pooled
 * `pg` client, or a pglite instance) — never a bare pool, whose calls can land
 * on different connections and split a transaction apart.
 */
export async function withTransaction(
  conn: Queryable,
  fn: (tx: Queryable) => Promise<void>,
): Promise<void> {
  await conn.query('BEGIN');
  try {
    await fn(conn);
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  }
}

/**
 * Apply the side effects of one synchronous engine call to Postgres.
 *
 * Mapping (spec §2):
 *   trade            -> insert 1 row into `trades`, then 2 rows into
 *                       `ledger_entries` (one per side: buyer + seller).
 *   order_resting    -\
 *   order_filled      >- update the order's row (status, filled_quantity).
 *   order_cancelled  -/
 *   order_rejected   -> not persisted here; Laravel owns rejection state.
 *
 * Each event is guarded independently — a failing write is logged and the loop
 * continues, so a Postgres hiccup can neither throw out of the caller nor
 * corrupt the book.
 */
export async function persistEvents(
  db: Db,
  events: EngineEvent[],
  logger: PersistLogger = defaultLogger,
): Promise<void> {
  for (const event of events) {
    try {
      switch (event.type) {
        case 'trade':
          // The trade row and its two ledger rows commit together or not at
          // all — a trade with zero ledger rows is a permanent audit hole,
          // unreconcilable against the in-memory engine later. If either insert
          // fails the transaction rolls back and rethrows, and the event-level
          // catch below logs and swallows it exactly as for any other event.
          await db.transaction(async (tx) => {
            await insertTrade(tx, event.trade);
            await insertLedgerEntries(tx, event.trade);
          });
          break;
        case 'order_resting':
        case 'order_filled':
        case 'order_cancelled':
          await updateOrder(db, event.order);
          break;
        case 'order_rejected':
          // Deliberately not persisted here (spec §2 lists only the three
          // above). Laravel records rejection on its side.
          break;
      }
    } catch (err) {
      logger.error(`persistEvents: failed to persist '${event.type}' event`, err);
      // swallow — do not rethrow, do not touch the in-memory book
    }
  }
}

async function insertTrade(db: Queryable, t: Trade): Promise<void> {
  await db.query(
    `INSERT INTO trades
       (id, instrument_id, buy_order_id, sell_order_id, price, quantity, sequence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.id, t.instrumentId, t.buyOrderId, t.sellOrderId, t.price, t.quantity, t.sequence],
  );
}

async function insertLedgerEntries(db: Queryable, t: Trade): Promise<void> {
  // Exactly two rows: the buyer's side and the seller's side. The owning account
  // for each side is looked up from the order row Laravel already persisted, so
  // the engine's Trade type does not need to carry account ids. This records the
  // fill only — no realized P&L or margin (that is Laravel's job later).
  await db.query(
    `INSERT INTO ledger_entries
       (account_id, instrument_id, trade_id, order_id, side, quantity, price, sequence)
     VALUES
       ((SELECT account_id FROM orders WHERE id = $1), $2, $3, $1, 'buy',  $4, $5, $6),
       ((SELECT account_id FROM orders WHERE id = $7), $2, $3, $7, 'sell', $4, $5, $6)`,
    [t.buyOrderId, t.instrumentId, t.id, t.quantity, t.price, t.sequence, t.sellOrderId],
  );
}

async function updateOrder(db: Queryable, o: Order): Promise<void> {
  await db.query(
    `UPDATE orders
        SET status = $2, filled_quantity = $3, updated_at = now()
      WHERE id = $1`,
    [o.id, o.status, o.filledQuantity],
  );
}
