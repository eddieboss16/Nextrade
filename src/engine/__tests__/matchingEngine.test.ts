import { describe, it, expect, beforeEach } from 'vitest';
import { MatchingEngine } from '../matchingEngine';
import type { EngineEvent, Trade, SubmitOrderInput } from '../types';

const INST = 'INST';

// A fresh engine per test keeps ids/sequences deterministic (order-1, order-2, ...).
let engine: MatchingEngine;
beforeEach(() => {
  engine = new MatchingEngine();
});

// --- helpers ---------------------------------------------------------------

function limit(
  side: 'buy' | 'sell',
  price: number,
  quantity: number,
  accountId: string,
): SubmitOrderInput {
  return { instrumentId: INST, accountId, side, type: 'limit', price, quantity };
}

function market(
  side: 'buy' | 'sell',
  quantity: number,
  accountId: string,
): SubmitOrderInput {
  return {
    instrumentId: INST,
    accountId,
    side,
    type: 'market',
    price: null,
    quantity,
  };
}

function tradesOf(events: EngineEvent[]): Trade[] {
  return events.flatMap((e) => (e.type === 'trade' ? [e.trade] : []));
}

function typesOf(events: EngineEvent[]): string[] {
  return events.map((e) => e.type);
}

// --- required test cases (spec §"Required test cases") ---------------------

it('1. a resting limit order with no match sits untouched in the book', () => {
  const events = engine.submitOrder(limit('buy', 100, 5, 'A'));

  expect(tradesOf(events)).toHaveLength(0);
  expect(typesOf(events)).toContain('order_resting');
  expect(engine.getSnapshot(INST).bids).toEqual([{ price: 100, quantity: 5 }]);
});

it('2. two resting orders at one price: incoming matches the older first (time priority)', () => {
  engine.submitOrder(limit('sell', 100, 5, 'S1')); // order-1, older
  engine.submitOrder(limit('sell', 100, 5, 'S2')); // order-2, newer
  const events = engine.submitOrder(limit('buy', 100, 5, 'B'));

  const trades = tradesOf(events);
  expect(trades).toHaveLength(1);
  expect(trades[0].sellOrderId).toBe('order-1'); // matched the OLDER resting sell
  // The newer sell is still resting.
  expect(engine.getSnapshot(INST).asks).toEqual([{ price: 100, quantity: 5 }]);
});

it('3. an incoming limit order partially fills against a resting order; remainder rests', () => {
  engine.submitOrder(limit('sell', 100, 3, 'S')); // only 3 available
  const events = engine.submitOrder(limit('buy', 100, 10, 'B')); // wants 10

  const trades = tradesOf(events);
  expect(trades).toHaveLength(1);
  expect(trades[0].quantity).toBe(3);
  expect(typesOf(events)).toContain('order_resting');
  // 7 of the buy rests on the bid side; the ask side is now empty.
  expect(engine.getSnapshot(INST).bids).toEqual([{ price: 100, quantity: 7 }]);
  expect(engine.getSnapshot(INST).asks).toEqual([]);
});

it('4. an incoming limit order fills across multiple price levels (price priority)', () => {
  engine.submitOrder(limit('sell', 101, 4, 'S1')); // better ask
  engine.submitOrder(limit('sell', 102, 4, 'S2')); // worse ask
  const events = engine.submitOrder(limit('buy', 102, 6, 'B'));

  const trades = tradesOf(events);
  expect(trades).toHaveLength(2);
  // Best (lowest) ask consumed first.
  expect(trades[0].price).toBe(101);
  expect(trades[0].quantity).toBe(4);
  expect(trades[1].price).toBe(102);
  expect(trades[1].quantity).toBe(2);
  // 2 remain resting at 102 on the ask side.
  expect(engine.getSnapshot(INST).asks).toEqual([{ price: 102, quantity: 2 }]);
});

it('5. a market order consumes multiple price levels until fully filled', () => {
  engine.submitOrder(limit('sell', 101, 3, 'S1'));
  engine.submitOrder(limit('sell', 103, 3, 'S2'));
  const events = engine.submitOrder(market('buy', 5, 'B'));

  const trades = tradesOf(events);
  expect(trades).toHaveLength(2);
  expect(trades[0].price).toBe(101);
  expect(trades[0].quantity).toBe(3);
  expect(trades[1].price).toBe(103);
  expect(trades[1].quantity).toBe(2);
  expect(typesOf(events)).toContain('order_filled');
  // Book: 1 left at 103, nothing rested from the market order.
  expect(engine.getSnapshot(INST).asks).toEqual([{ price: 103, quantity: 1 }]);
});

it('6. a market order with insufficient liquidity is partially filled; remainder dropped', () => {
  engine.submitOrder(limit('sell', 101, 2, 'S'));
  const events = engine.submitOrder(market('buy', 10, 'B'));

  const trades = tradesOf(events);
  expect(trades).toHaveLength(1);
  expect(trades[0].quantity).toBe(2);
  expect(typesOf(events)).toContain('order_filled'); // filled with what matched
  // Remainder (8) is dropped, NOT rested — no bids exist.
  expect(engine.getSnapshot(INST).bids).toEqual([]);
  expect(engine.getSnapshot(INST).asks).toEqual([]);
});

it('7. cancelling a resting order removes it; a later crossing order does not match it', () => {
  const resting = engine.submitOrder(limit('sell', 100, 5, 'S')); // order-1
  const restingId = resting.find((e) => e.type === 'order_resting');
  expect(restingId?.type).toBe('order_resting');

  engine.cancelOrder('order-1');
  expect(engine.getSnapshot(INST).asks).toEqual([]);

  // A buy that WOULD have crossed the cancelled ask now just rests.
  const events = engine.submitOrder(limit('buy', 100, 5, 'B'));
  expect(tradesOf(events)).toHaveLength(0);
  expect(engine.getSnapshot(INST).bids).toEqual([{ price: 100, quantity: 5 }]);
});

it('8. cancelling an already-filled order is a no-op and does not throw', () => {
  engine.submitOrder(limit('sell', 100, 5, 'S')); // order-1
  engine.submitOrder(limit('buy', 100, 5, 'B')); // order-2, fully fills order-1

  let result: EngineEvent[] = [];
  expect(() => {
    result = engine.cancelOrder('order-1'); // already filled
  }).not.toThrow();
  expect(result).toEqual([]);
});

it('9. cancelling a non-existent order id is a no-op and does not throw', () => {
  let result: EngineEvent[] = [];
  expect(() => {
    result = engine.cancelOrder('does-not-exist');
  }).not.toThrow();
  expect(result).toEqual([]);
});

it('10. an incoming order does not match a same-account resting order; it skips to the next', () => {
  engine.submitOrder(limit('sell', 100, 5, 'SAME')); // order-1, same account as incoming
  engine.submitOrder(limit('sell', 100, 5, 'OTHER')); // order-2, different account
  const events = engine.submitOrder(limit('buy', 100, 5, 'SAME'));

  const trades = tradesOf(events);
  expect(trades).toHaveLength(1);
  expect(trades[0].sellOrderId).toBe('order-2'); // skipped own order-1, hit order-2
  // order-1 (own) still rests untouched.
  expect(engine.getSnapshot(INST).asks).toEqual([{ price: 100, quantity: 5 }]);
});

it('11. every trade price equals the RESTING order price, never the incoming price', () => {
  // Resting asks at 101 and 103; incoming aggressive buy priced at 105.
  engine.submitOrder(limit('sell', 101, 2, 'S1'));
  engine.submitOrder(limit('sell', 103, 2, 'S2'));
  const events = engine.submitOrder(limit('buy', 105, 4, 'B'));

  const trades = tradesOf(events);
  expect(trades).toHaveLength(2);
  // Prices are the resting 101/103, NEVER the incoming 105.
  expect(trades.map((t) => t.price)).toEqual([101, 103]);
  expect(trades.every((t) => t.price !== 105)).toBe(true);
});

it('12. after partial fills and cancels, the snapshot aggregates correct depth per level', () => {
  engine.submitOrder(limit('buy', 100, 5, 'A')); // order-1
  engine.submitOrder(limit('buy', 100, 5, 'B')); // order-2  -> level 100 total 10
  engine.submitOrder(limit('buy', 99, 8, 'C')); // order-3  -> level 99 total 8

  // A sell partially eats the 100 level: consumes order-1 (5) + 2 of order-2.
  engine.submitOrder(limit('sell', 100, 7, 'D')); // order-4

  // Cancel order-3 entirely.
  engine.cancelOrder('order-3');

  // Remaining: order-2 has 3 left at price 100; level 99 gone.
  expect(engine.getSnapshot(INST).bids).toEqual([{ price: 100, quantity: 3 }]);
  expect(engine.getSnapshot(INST).asks).toEqual([]);
});

it('13. a zero or negative quantity order is rejected before touching the book', () => {
  const zero = engine.submitOrder(limit('buy', 100, 0, 'A'));
  expect(typesOf(zero)).toEqual(['order_rejected']);

  const negative = engine.submitOrder(limit('buy', 100, -5, 'A'));
  expect(typesOf(negative)).toEqual(['order_rejected']);

  // Nothing rested.
  expect(engine.getSnapshot(INST).bids).toEqual([]);
});

it('13b. a limit order with null or non-positive price is rejected (validation sibling)', () => {
  const nullPrice = engine.submitOrder({
    instrumentId: INST,
    accountId: 'A',
    side: 'buy',
    type: 'limit',
    price: null,
    quantity: 5,
  });
  expect(typesOf(nullPrice)).toEqual(['order_rejected']);

  const zeroPrice = engine.submitOrder(limit('buy', 0, 5, 'A'));
  expect(typesOf(zeroPrice)).toEqual(['order_rejected']);

  expect(engine.getSnapshot(INST).bids).toEqual([]);
});

it('14. property check: the book is never crossed (best bid < best ask) after any op sequence', () => {
  // Deterministic PRNG so a failure is reproducible. Returns a uint32 so every
  // derived value stays an integer — no float literals anywhere in this test.
  const rng = mulberry32(0xc0ffee);
  const randInt = (n: number) => rng() % n;
  const liveIds: string[] = [];
  let acct = 0;

  for (let step = 0; step < 400; step++) {
    if (randInt(4) === 0 && liveIds.length > 0) {
      // Cancel a random previously-seen order.
      engine.cancelOrder(liveIds[randInt(liveIds.length)]);
    } else {
      // Submit a new limit order. Unique account per order => self-trade
      // prevention never blocks a cross, so any crossing order clears.
      const side = randInt(2) === 0 ? 'buy' : 'sell';
      const price = 1 + randInt(20); // integer 1..20
      const quantity = 1 + randInt(10); // integer 1..10
      acct += 1;
      const events = engine.submitOrder(limit(side, price, quantity, `acct-${acct}`));
      const rested = events.find((e) => e.type === 'order_resting');
      if (rested && rested.type === 'order_resting') liveIds.push(rested.order.id);
    }

    const bid = engine.getBestBid(INST);
    const ask = engine.getBestAsk(INST);
    if (bid !== undefined && ask !== undefined) {
      expect(bid).toBeLessThan(ask);
    }
  }
});

// Small seeded PRNG (mulberry32), returning a uint32 — integer-only so no float
// literals leak into the test or into any order's price/quantity.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

describe('placeholder describe to keep grouping tidy', () => {
  it('engine constructs with an empty book', () => {
    const fresh = new MatchingEngine();
    expect(fresh.getSnapshot(INST).bids).toEqual([]);
    expect(fresh.getSnapshot(INST).asks).toEqual([]);
    expect(fresh.getBestBid(INST)).toBeUndefined();
    expect(fresh.getBestAsk(INST)).toBeUndefined();
  });
});

describe('sequence seeding across restart (collision fix)', () => {
  it('a fresh engine starts sequence/ids at 1 (default behaviour unchanged)', () => {
    const fresh = new MatchingEngine();
    const events = fresh.submitOrder(limit('buy', 100, 5, 'A'));
    const rested = events.find((e) => e.type === 'order_resting');
    expect(rested?.type).toBe('order_resting');
    if (rested && rested.type === 'order_resting') {
      expect(rested.order.id).toBe('order-1');
      expect(rested.order.sequence).toBe(1);
    }
  });

  it('a seeded engine continues after a restart without reusing persisted sequences', () => {
    // Simulate a restart: Postgres already holds orders/trades up through
    // sequence 42, so the engine is re-seeded with the next value, 43.
    const resumed = new MatchingEngine(43);

    const events = resumed.submitOrder(limit('buy', 100, 5, 'A'));
    const rested = events.find((e) => e.type === 'order_resting');
    expect(rested?.type).toBe('order_resting');
    if (rested && rested.type === 'order_resting') {
      expect(rested.order.id).toBe('order-43'); // NOT order-1
      expect(rested.order.sequence).toBe(43);
    }

    // A trade produced after the restart also draws from the seeded counter.
    const cross = resumed.submitOrder(limit('sell', 100, 5, 'B'));
    const trade = cross.flatMap((e) => (e.type === 'trade' ? [e.trade] : []))[0];
    expect(trade).toBeDefined();
    expect(trade!.sequence).toBeGreaterThan(42);
  });

  it('rejects a non-positive or non-integer start sequence', () => {
    expect(() => new MatchingEngine(0)).toThrow();
    expect(() => new MatchingEngine(-1)).toThrow();
    expect(() => new MatchingEngine(3 / 2)).toThrow(); // 1.5, non-integer
  });
});
