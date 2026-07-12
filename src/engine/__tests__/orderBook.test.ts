import { describe, it, expect } from 'vitest';
import { OrderBook } from '../orderBook';
import type { Order, OrderSide } from '../types';

// Build a fully-formed resting Order. All values are integers.
let seq = 0;
function makeOrder(
  side: OrderSide,
  price: number,
  quantity: number,
  opts: { accountId?: string; instrumentId?: string; id?: string } = {},
): Order {
  seq += 1;
  return {
    id: opts.id ?? `o-${seq}`,
    instrumentId: opts.instrumentId ?? 'INST',
    accountId: opts.accountId ?? `acct-${seq}`,
    side,
    type: 'limit',
    price,
    quantity,
    filledQuantity: 0,
    status: 'open',
    sequence: seq,
  };
}

describe('OrderBook storage primitives', () => {
  it('rests an order and reports it in the snapshot and best price', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('buy', 100, 5, { id: 'b1' }));

    expect(book.getBestBid('INST')).toBe(100);
    expect(book.getBestAsk('INST')).toBeUndefined();
    expect(book.getSnapshot('INST').bids).toEqual([{ price: 100, quantity: 5 }]);
  });

  it('keeps price levels sorted best-first (bids desc, asks asc)', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('buy', 100, 1));
    book.addOrder(makeOrder('buy', 102, 1));
    book.addOrder(makeOrder('buy', 101, 1));
    book.addOrder(makeOrder('sell', 110, 1));
    book.addOrder(makeOrder('sell', 108, 1));
    book.addOrder(makeOrder('sell', 109, 1));

    expect(book.getSnapshot('INST').bids.map((l) => l.price)).toEqual([
      102, 101, 100,
    ]);
    expect(book.getSnapshot('INST').asks.map((l) => l.price)).toEqual([
      108, 109, 110,
    ]);
    expect(book.getBestBid('INST')).toBe(102);
    expect(book.getBestAsk('INST')).toBe(108);
  });

  it('peekMatchable returns the oldest order at the best level (FIFO)', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('sell', 100, 5, { id: 'old' }));
    book.addOrder(makeOrder('sell', 100, 5, { id: 'new' }));

    const match = book.peekMatchable('INST', 'sell', 'buyer', 100);
    expect(match?.id).toBe('old');
  });

  it('peekMatchable skips same-account orders (self-trade prevention)', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('sell', 100, 5, { id: 'mine', accountId: 'A' }));
    book.addOrder(makeOrder('sell', 100, 5, { id: 'theirs', accountId: 'B' }));

    const match = book.peekMatchable('INST', 'sell', 'A', 100);
    expect(match?.id).toBe('theirs');
  });

  it('peekMatchable stops once price eligibility fails', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('sell', 105, 5, { accountId: 'B' }));
    // A buy limit priced at 104 cannot cross a resting ask at 105.
    expect(book.peekMatchable('INST', 'sell', 'A', 104)).toBeUndefined();
    // At 105 it can.
    expect(book.peekMatchable('INST', 'sell', 'A', 105)).toBeDefined();
  });

  it('market orders (null limit) always match if any resting order exists', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('sell', 999, 1, { accountId: 'B' }));
    expect(book.peekMatchable('INST', 'sell', 'A', null)).toBeDefined();
  });

  it('removeOrder is O(1)-lookup, drops empty levels, and is a no-op for unknown ids', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('buy', 100, 5, { id: 'b1' }));
    book.addOrder(makeOrder('buy', 100, 5, { id: 'b2' }));

    expect(book.removeOrder('b1')?.id).toBe('b1');
    // Level still present because b2 remains.
    expect(book.getSnapshot('INST').bids).toEqual([{ price: 100, quantity: 5 }]);

    expect(book.removeOrder('b2')?.id).toBe('b2');
    // Level now gone entirely.
    expect(book.getSnapshot('INST').bids).toEqual([]);
    expect(book.getBestBid('INST')).toBeUndefined();

    // Unknown id must not throw.
    expect(() => book.removeOrder('nope')).not.toThrow();
    expect(book.removeOrder('nope')).toBeUndefined();
  });

  it('aggregates remaining (unfilled) quantity per price level', () => {
    const book = new OrderBook();
    const partial = makeOrder('buy', 100, 10, { id: 'p' });
    partial.filledQuantity = 4; // 6 remaining
    book.addOrder(partial);
    book.addOrder(makeOrder('buy', 100, 5, { id: 'q' })); // 5 remaining

    expect(book.getSnapshot('INST').bids).toEqual([
      { price: 100, quantity: 11 },
    ]);
  });

  it('isolates instruments from each other', () => {
    const book = new OrderBook();
    book.addOrder(makeOrder('buy', 100, 5, { instrumentId: 'AAA' }));
    book.addOrder(makeOrder('buy', 200, 5, { instrumentId: 'BBB' }));

    expect(book.getBestBid('AAA')).toBe(100);
    expect(book.getBestBid('BBB')).toBe(200);
    expect(book.getSnapshot('AAA').bids).toEqual([{ price: 100, quantity: 5 }]);
  });
});
