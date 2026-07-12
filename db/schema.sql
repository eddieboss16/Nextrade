-- ============================================================================
-- next-trade-engine — Week 2 database schema (plain SQL DDL)
-- ============================================================================
--
-- WHAT THIS IS
--   The five core tables the Node persistence layer (src/db, Week 2 step 3)
--   writes to: instruments, accounts, orders, trades, ledger_entries.
--
--   This is the Week 2 roadmap step-1 prerequisite, done as raw DDL instead of
--   Laravel migrations (roadmap "Option 2"): Node only needs the tables to
--   exist, not Laravel-flavored migration files. In Week 3 Laravel writes its
--   real migrations against THIS SAME shape and supersedes this script —
--   Eloquent does not care whether a table was born from raw SQL or a
--   migration, only that the columns match. Keep this file and the eventual
--   migrations in lock-step.
--
-- CONVENTIONS (permanent invariants — see CLAUDE.md)
--   * INTEGERS ONLY. Every price/quantity column is BIGINT in the smallest
--     meaningful unit. No NUMERIC/DECIMAL/DOUBLE/MONEY anywhere. No floats.
--   * APPEND-ONLY LEDGER. ledger_entries is never updated or deleted (enforced
--     by trigger below); an account's position/balance is DERIVED from it,
--     never stored as a mutable column.
--   * Enum-like columns (side/type/status) use TEXT + CHECK so the values match
--     the engine's string unions exactly and stay easy for Laravel to mirror.
--   * snake_case columns, TIMESTAMPTZ timestamps — Eloquent-friendly defaults.
--
-- TO (RE)INITIALISE A LOCAL DB
--   psql "$DATABASE_URL" -f db/schema.sql
--   The whole script runs in one transaction (Postgres DDL is transactional),
--   so a failure leaves the database untouched. To start clean, uncomment the
--   DROP block immediately below — it is DESTRUCTIVE and off by default.
-- ============================================================================

BEGIN;

-- --- Optional clean-slate reset (DESTRUCTIVE — uncomment deliberately) -------
-- DROP TABLE IF EXISTS ledger_entries CASCADE;
-- DROP TABLE IF EXISTS trades         CASCADE;
-- DROP TABLE IF EXISTS orders         CASCADE;
-- DROP TABLE IF EXISTS accounts       CASCADE;
-- DROP TABLE IF EXISTS instruments    CASCADE;
-- DROP FUNCTION IF EXISTS ledger_entries_forbid_mutation() CASCADE;

-- ----------------------------------------------------------------------------
-- instruments — tradeable symbols. Referenced by everything else.
--   id matches the engine's Order.instrumentId (an opaque string).
--   *_scale document how many implied decimals a UI applies for display only;
--   storage is always the integer smallest unit, so scale never touches math.
-- ----------------------------------------------------------------------------
CREATE TABLE instruments (
    id              TEXT        PRIMARY KEY,
    symbol          TEXT        NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    price_scale     INTEGER     NOT NULL DEFAULT 0 CHECK (price_scale >= 0),
    quantity_scale  INTEGER     NOT NULL DEFAULT 0 CHECK (quantity_scale >= 0),
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- accounts — trading accounts.
--   id matches the engine's Order.accountId (opaque string).
--   NOTE: there is intentionally NO balance column. Balance/position is derived
--   from ledger_entries (see the query note on that table).
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
    id          TEXT        PRIMARY KEY,
    name        TEXT        NOT NULL,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- orders — one row per submitted order, mirroring the engine's Order type.
--   The persistence layer inserts on intake and UPDATEs status/filled_quantity
--   as fills and cancels arrive. CHECK constraints reproduce the engine's own
--   validation so the DB rejects anything the engine would have rejected.
-- ----------------------------------------------------------------------------
CREATE TABLE orders (
    id              TEXT        PRIMARY KEY,                      -- engine Order.id
    instrument_id   TEXT        NOT NULL REFERENCES instruments(id),
    account_id      TEXT        NOT NULL REFERENCES accounts(id),
    side            TEXT        NOT NULL CHECK (side IN ('buy', 'sell')),
    type            TEXT        NOT NULL CHECK (type IN ('limit', 'market')),
    price           BIGINT      CHECK (price IS NULL OR price > 0), -- smallest unit; NULL for market
    quantity        BIGINT      NOT NULL CHECK (quantity > 0),
    filled_quantity BIGINT      NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
    -- 'pending' is a Laravel-side transient status: Laravel inserts the order as
    -- 'pending' before forwarding it to the engine, then this module updates it
    -- to an engine status on the resulting events. 'pending' deliberately does
    -- NOT exist in the engine's OrderStatus type — it only ever lives in Postgres.
    status          TEXT        NOT NULL CHECK (
                        status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected')
                    ),
    sequence        BIGINT      NOT NULL,                         -- engine monotonic intake sequence
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- limit orders REQUIRE a positive price; market orders REQUIRE null price.
    CONSTRAINT orders_price_matches_type CHECK (
        (type = 'limit'  AND price IS NOT NULL) OR
        (type = 'market' AND price IS NULL)
    ),
    -- a fill can never exceed the order size.
    CONSTRAINT orders_filled_not_over_quantity CHECK (filled_quantity <= quantity)
);

CREATE INDEX orders_instrument_status_idx ON orders (instrument_id, status);
CREATE INDEX orders_account_idx           ON orders (account_id);
CREATE INDEX orders_instrument_seq_idx    ON orders (instrument_id, sequence);

-- ----------------------------------------------------------------------------
-- trades — one row per match, mirroring the engine's Trade type.
--   price is ALWAYS the resting order's price (permanent invariant). Insert-only
--   in practice; a trade is a historical fact and is never amended.
-- ----------------------------------------------------------------------------
CREATE TABLE trades (
    id              TEXT        PRIMARY KEY,                      -- engine Trade.id
    instrument_id   TEXT        NOT NULL REFERENCES instruments(id),
    buy_order_id    TEXT        NOT NULL REFERENCES orders(id),
    sell_order_id   TEXT        NOT NULL REFERENCES orders(id),
    price           BIGINT      NOT NULL CHECK (price > 0),       -- resting order's price, smallest unit
    quantity        BIGINT      NOT NULL CHECK (quantity > 0),
    sequence        BIGINT      NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- the two sides of a trade are always different orders.
    CONSTRAINT trades_distinct_orders CHECK (buy_order_id <> sell_order_id)
);

CREATE INDEX trades_instrument_seq_idx ON trades (instrument_id, sequence);
CREATE INDEX trades_buy_order_idx      ON trades (buy_order_id);
CREATE INDEX trades_sell_order_idx     ON trades (sell_order_id);

-- ----------------------------------------------------------------------------
-- ledger_entries — APPEND-ONLY record of each side of each trade.
--   Roadmap step 3: "one row per side of a trade — recording the trade only,
--   not calculating realized P&L or margin" (that is Laravel's job later). So a
--   single match writes TWO rows: one for the buyer, one for the seller. Each
--   row is the raw fact of a fill from one account's perspective; no cash/P&L
--   projection is computed here.
--
--   Position is DERIVED, never stored:
--     SELECT COALESCE(SUM(CASE side WHEN 'buy' THEN quantity ELSE -quantity END), 0)
--       FROM ledger_entries
--      WHERE account_id = $1 AND instrument_id = $2;
-- ----------------------------------------------------------------------------
CREATE TABLE ledger_entries (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id      TEXT        NOT NULL REFERENCES accounts(id),
    instrument_id   TEXT        NOT NULL REFERENCES instruments(id),
    trade_id        TEXT        NOT NULL REFERENCES trades(id),
    order_id        TEXT        NOT NULL REFERENCES orders(id),
    side            TEXT        NOT NULL CHECK (side IN ('buy', 'sell')), -- this account's side of the fill
    quantity        BIGINT      NOT NULL CHECK (quantity > 0),
    price           BIGINT      NOT NULL CHECK (price > 0),               -- trade (resting) price, smallest unit
    sequence        BIGINT      NOT NULL,                                 -- source trade's sequence, for ordering
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_instrument_idx ON ledger_entries (account_id, instrument_id);
CREATE INDEX ledger_entries_trade_idx              ON ledger_entries (trade_id);
CREATE INDEX ledger_entries_account_seq_idx        ON ledger_entries (account_id, sequence);

-- Enforce append-only at the database level: block UPDATE and DELETE outright.
-- This makes "the ledger is append-only" a guarantee, not a convention. If a
-- later, deliberate correction workflow ever needs to reverse an entry, it does
-- so by INSERTing a compensating row, never by mutating history. Drop this
-- trigger only as an explicit, reviewed decision.
CREATE FUNCTION ledger_entries_forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_forbid_mutation();

COMMIT;
