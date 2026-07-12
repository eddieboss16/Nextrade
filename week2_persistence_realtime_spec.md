Week 2 Spec — Persistence + Real-Time Layer

Repo: next-trade-engine (same repo, new modules alongside src/engine)
Scope this week: wire engine events to Postgres, stand up the WebSocket broadcast server, expose an internal-only HTTP surface for order submission and cancellation. src/engine itself does not change this week — if it needs to change, that's a Week 1 defect, not Week 2 work.

Prerequisite — do this before writing any Week 2 code

The orders, trades, and ledger_entries tables must exist in Postgres. Laravel owns the schema and migrations, and Laravel's own build is Week 3 — but this module needs those tables now. Pull forward only the migration files for these three tables (plus accounts and instruments, since trades reference them) and run them against a local Postgres instance. Do not pull forward any other part of Laravel's Week 3 scope — auth, the API layer, none of it. This is a narrow, deliberate exception.

Hard boundaries


src/engine is untouched. This week wraps it, it does not modify it.
No Express/Fastify framework — a raw Node http server or a minimal router is enough for two internal endpoints. Don't pull in a full framework for this.
No price feed / simulated ticks — that's Week 4, scoped separately.
No changes to the synchronous guarantee inside submitOrder/cancelOrder. This week adds async work around those calls, never inside them.


The one rule that matters most this week

Between parsing an incoming HTTP request body and calling engine.submitOrder() or engine.cancelOrder(), there must be no await. If you add an async pre-check — an idempotency lookup, a validation call — before the synchronous engine call, you reopen a check-then-act race between concurrent requests that the single-threaded design was built to prevent. Do any async work either before parsing the body, or after the synchronous engine call has already returned. Never between.

1. Internal HTTP surface

Two endpoints, bound to 127.0.0.1 only — never exposed publicly. Laravel is the only caller, over the loopback interface on the same box.

POST /internal/orders             submit a new order
POST /internal/orders/:id/cancel  cancel an existing order

Laravel has already validated the account, checked balance/margin, and persisted the order as pending before it reaches here. This endpoint trusts that and focuses on one job: call into the engine synchronously, then let the resulting events drive persistence and broadcast.

Reject with a clear error (not a silent 200) if the order id given already exists in the engine's in-memory state — this is your defense against a duplicate forward from Laravel, on top of whatever idempotency check Laravel does on its own side.

2. Persistence layer

src/db/ — a thin wrapper around pg (node-postgres), no ORM. Laravel owns the schema; this module only writes to it.

For every EngineEvent returned by a synchronous engine call, after the call has returned:


trade → insert a row into trades.
trade → insert a row into ledger_entries for each side of the trade (buy account, sell account). This week, a ledger entry records that a trade happened against an account — it does not calculate realized P&L or margin impact. That calculation is Laravel's concern in a later week; don't build it here.
order_resting / order_filled / order_cancelled → update the corresponding row in orders (status, filled_quantity).


These writes are async and happen after the synchronous engine call completes — they never block the next call into the engine. If a write fails, log it and continue; a Postgres hiccup must not corrupt or freeze the in-memory order book, which remains the source of truth for matching regardless of persistence state.

3. WebSocket broadcast server

src/ws/ — one WS server, one channel per instrument (/stream/:instrumentId).

On the same EngineEvent list used for persistence, broadcast to subscribed clients:


Every trade → a trade print (price, quantity, timestamp).
Any event that changes book depth (order_resting, order_filled on a resting order, order_cancelled) → a refreshed depth snapshot for that price level, using engine.getSnapshot(instrumentId) — don't hand-roll a diff this week, the full snapshot is simpler and correct, and depth at demo volume is small enough that this isn't a real cost.


Broadcasting is fire-and-forget from the engine's perspective — a slow or disconnected client must never be able to block or slow down order processing.

Required tests


POST /internal/orders with a valid order returns success and results in the expected trade(s)/resting state — assert against the engine's own snapshot, not just the HTTP response.
POST /internal/orders with a duplicate id is rejected, not silently accepted twice.
POST /internal/orders/:id/cancel on a resting order removes it from the book and updates its Postgres row to cancelled.
A trade event results in exactly one row in trades and exactly two rows in ledger_entries (one per side).
A Postgres write failure (simulate by pointing at a broken connection) does not throw out of the HTTP handler and does not corrupt subsequent engine calls — submit another order right after and confirm the engine still matches correctly.
A WS client subscribed to an instrument receives a trade print immediately after a matching order is submitted via HTTP.
A WS client subscribed to one instrument does not receive events for a different instrument.
Confirm by inspection (not just tests) that no await sits between request-body parsing and the engine.submitOrder/cancelOrder call in either endpoint handler.


Acceptance criteria for Week 2


All required tests above pass.
src/engine has zero diffs from the end of Week 1.
The internal HTTP server is verifiably bound to 127.0.0.1, not 0.0.0.0 — check this explicitly, don't assume the framework default is safe.
A trade submitted via HTTP is independently verifiable in three places: the engine's in-memory snapshot, the trades/ledger_entries tables in Postgres, and a connected WS client's received message. If any one of these three disagrees with the others, that's the bug to chase before moving on.


If Fable 5 or Opus proposes adding the price feed, margin/PnL calculation, or exposing the internal endpoints publicly "since Laravel isn't built yet" — that's scope creep. Push back on it, same as last week.