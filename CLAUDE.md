# Next Trade — Project Context

## What this is

A demo / simulation trading matching engine, built to be sold to brokers as white-label
infrastructure — not a licensed broker holding real client funds. No real fund custody,
no regulatory licensing requirement, in v1. That framing is load-bearing: it is why this
can be built and demoed without a financial services license. Do not let scope drift
toward real custody without that conversation happening explicitly first.

## Stack — decided, do not re-litigate

- **This repo (`next-trade-engine`):** Node.js + TypeScript matching engine. Node 22 or
  24 (either LTS line is fine — do not treat this as a hard requirement). TypeScript
  strict mode. Vitest. No runtime dependencies in `src/engine` — it is a pure,
  dependency-free library.
- **Separate repo (`next-trade-api`, not started yet):** Laravel. Owns auth, accounts,
  order intake/validation, order history, admin, and the Postgres schema/migrations.
- **Shared Postgres**, one instance, both services connect to it directly. No queue
  (Kafka/RabbitMQ) between them — a direct internal HTTP call is sufficient at this
  scale.
- **Cut for v1, do not re-add without an explicit decision to reverse this:**
  Kafka/RabbitMQ, microservices, AI fraud detection, DEX/smart contracts, crypto-style
  hot/cold wallets, KYC vendor integration, MFA/OAuth beyond basic auth. Each was cut for
  a specific reason (see the project plan doc) — "it would be more robust" is not
  sufficient reason to reverse a cut; a real, current requirement is.

## Permanent invariants — apply in every future session, not just this week

- **Integers only.** Price and quantity are integers in the smallest meaningful unit,
  everywhere — types, code, tests, database columns. No floats, ever.
- **The matching engine is single-threaded per instrument, by design.** This is what
  makes it correct without locks. `submitOrder` and `cancelOrder` in `src/engine` must
  never contain `await`, Promises, or callbacks. This is what makes concurrent calls
  safe — breaking it reintroduces the exact race condition the design avoids.
- **The ledger is append-only.** Account balance is derived from `ledger_entries`, never
  trusted as a single mutable column.
- **Trade price is always the resting order's price**, never the incoming order's.
- **Market orders never rest in the book.** An unfilled remainder on a market order is
  dropped, not queued.
- **Self-trade prevention skips, it does not abort.** An incoming order that would match
  its own resting order skips past it (preserving FIFO for everyone else) and continues
  — it does not reject the whole incoming order.
- **Cancel goes through the same synchronous path as submit.** Never implement cancel as
  a direct mutation from outside the engine's own queue.
- **Engine restart loses resting-order state.** The in-memory order book is not
  rehydrated from Postgres on startup — engine restart currently loses all resting order
  state; full rehydration from Postgres is out of scope for v1. (The sequence counter
  *is* re-seeded from `MAX(sequence)` on restart, via `new MatchingEngine(startSequence)`,
  so regenerated ids never collide with persisted rows — but pre-restart resting orders
  are gone from the book and do not resume matching.)
- **A failed persistence write can leave an order row at a stale status.** If a Postgres
  write fails after a match (e.g. the row stays `pending` in the DB even though the order
  has actually filled in memory), the write is logged and skipped, not retried. The
  in-memory engine remains authoritative for matching state — the stale Postgres row is
  never trusted over it. Automatic reconciliation of stuck/stale rows is out of scope for
  v1.

## Status

### Week 1 — COMPLETE, verified, do not modify without cause

`src/engine` (`types.ts`, `orderBook.ts`, `matchingEngine.ts`) is implemented and
verified — not just tested, independently reviewed:

- 28 tests passing: the original 25 Week 1 tests are unmodified (all 14 required cases
  mapped one-to-one, not diluted into combined tests, plus supplementary `OrderBook`
  unit tests), joined by 3 additive restart-seeding regression tests.
- Confirmed by direct code inspection: self-trade skip correctly `continue`s within a
  price level and falls through to the next level rather than aborting the match.
- Confirmed by type-level proof under strict `tsc`: zero `await` in the hot path —
  `submitOrder`/`cancelOrder` have non-`Promise` return types, which is structurally
  incompatible with containing `await`.
- Confirmed by code inspection: `peekMatchable` returns live object references from the
  book's internal storage, not clones — mutations in the matching loop correctly persist.

**Do not touch `src/engine` during Week 2 unless a genuine defect is found in it.** If a
Week 2 bug looks like it originates here, treat that as notable and flag it explicitly —
it should not need to change.

**Week 2 exception to the engine's public surface (logged deliberately):** `MatchingEngine`
gained an optional `startSequence` constructor argument (default `1`) so the Week 2
persistence bootstrap can re-seed the sequence counter from Postgres on restart. This is an
intentional Week 2 addition to the engine's public API — **not** a "corrected Week 1
baseline." The Week 1 internals (matching/cancel logic, the synchronous hot path) are
unchanged; only the constructor signature was extended. Any further engine change still
needs explicit justification and flagging.

### Week 2 — IN PROGRESS (current focus)

Scope: persistence layer, WebSocket broadcast, and an internal-only HTTP surface for
order submission/cancellation. Full spec: `week2_persistence_realtime_spec.md`.

## Week 2 roadmap

1. **Prerequisite (blocking) — DONE.** The five tables (`orders`, `trades`,
   `ledger_entries`, `accounts`, `instruments`) exist as plain SQL DDL in `db/schema.sql`
   (Option 2: raw DDL now; Laravel writes real migrations against the same shape in
   Week 3). Applied and its guards exercised in-process via pglite — the price/type and
   distinct-orders CHECK constraints and the append-only `ledger_entries` trigger were
   each confirmed to reject violations. Bootstrap note for step 3: on startup, read
   `MAX(sequence)` across `orders` and `trades` and construct the engine as
   `new MatchingEngine(max + 1)` so ids never collide after a restart.
2. **Internal HTTP surface:** `POST /internal/orders`, `POST /internal/orders/:id/cancel`.
   Bound to `127.0.0.1` only — verify this explicitly, don't assume a framework default
   is safe. No `await` between parsing the request body and calling into the engine.
3. **Persistence layer (`src/db`):** plain `pg` client, no ORM. On engine events: write
   `trades`, write `ledger_entries` (one row per side of a trade — recording the trade
   only, not calculating realized P&L or margin, which is Laravel's job later), update
   `orders` status/filled_quantity.
4. **WebSocket broadcast (`src/ws`):** one channel per instrument. Trade prints on every
   match; a refreshed depth snapshot (via `engine.getSnapshot`) on anything that changes
   book depth. Broadcasting must never block order processing.
5. **Tests:** the 8 required cases in the Week 2 spec, including the Postgres-failure
   resilience case and the cross-instrument WS isolation case.
6. **Verification, not just green tests:** a single submitted trade must be
   independently checkable in three places — the engine's in-memory snapshot, the
   Postgres rows, and a connected WS client's received message. Disagreement between any
   two of these is the bug to chase before calling the week done.

## Hard boundaries this week

- No changes to `src/engine` internals — with one deliberate, logged exception to its
  public surface: the `startSequence` constructor argument (see the Week 1 status note
  above). Matching/cancel logic is untouched. Any further engine change needs explicit
  justification, flagged.
- No full HTTP framework (Express/Fastify) — Node's built-in `http` or a minimal router
  is enough for two internal endpoints.
- No price feed / simulated ticks — that's Week 4.
- Internal endpoints are never publicly exposed, including "temporarily, since Laravel
  isn't built yet."

## After Week 2

Week 3 starts `next-trade-api` (Laravel): full migrations (superseding the pulled-forward
ones from Week 2's prerequisite), Sanctum auth, accounts, and the `/orders` endpoint that
validates and forwards to this repo's internal HTTP surface.
