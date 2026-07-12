// Engine sequence bootstrap.
//
// On startup the in-memory sequence counter must continue past the highest
// sequence already persisted, or regenerated order/trade ids would collide with
// rows already in Postgres. The counter is shared across orders and trades, so
// the next value is one past the max of BOTH tables.
//
// COALESCE(..., 0) makes the first-ever startup (both tables empty) resolve to
// GREATEST(0, 0) + 1 = 1 — identical to a fresh engine — instead of NULL.

import type { Queryable } from './persistence';

/**
 * Read the next sequence value the engine should hand out:
 * `GREATEST(MAX(orders.sequence), MAX(trades.sequence)) + 1`, with empty tables
 * treated as 0. Feed the result to `new MatchingEngine(nextSequence)`.
 */
export async function readNextSequence(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    `SELECT GREATEST(
              COALESCE((SELECT MAX(sequence) FROM orders), 0),
              COALESCE((SELECT MAX(sequence) FROM trades), 0)
            ) + 1 AS next`,
  );
  const row = rows[0] as { next: number | string } | undefined;
  // pg returns BIGINT as a string; normalise to a JS number.
  return Number(row?.next ?? 1);
}
