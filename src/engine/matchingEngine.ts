// Week 1 matching engine core.
//
// submitOrder() and cancelOrder() run to completion SYNCHRONOUSLY — no await,
// no Promises, no callbacks anywhere in the matching/cancel path. On Node's
// single-threaded event loop this is what makes the engine safe without locks:
// two calls can never interleave because neither yields control mid-execution.
// Both methods return the EngineEvent[] they produced; persistence/broadcast
// are week-2 side effects layered on top of these events, never inside the loop.

import { OrderBook } from './orderBook';
import type {
  Order,
  OrderSide,
  Trade,
  EngineEvent,
  SubmitOrderInput,
  BookSnapshot,
} from './types';

export class MatchingEngine {
  private readonly book = new OrderBook();
  private readonly orders = new Map<string, Order>(); // every order, all statuses
  private sequenceCounter: number; // shared across orders and trades

  // `startSequence` is the next sequence number the engine will hand out. On a
  // fresh engine it is 1. After a process restart it MUST be seeded to
  // (max persisted sequence across the `orders` and `trades` tables) + 1, so
  // regenerated order/trade ids and sequences can never collide with rows
  // already in Postgres. The DB read that computes that value happens in the
  // bootstrap/persistence layer, OUTSIDE the engine — the engine stays fully
  // synchronous and dependency-free, receiving only the resolved integer.
  constructor(startSequence: number = 1) {
    if (!Number.isInteger(startSequence) || startSequence < 1) {
      throw new Error(
        `startSequence must be a positive integer, got ${startSequence}`,
      );
    }
    this.sequenceCounter = startSequence;
  }

  private nextSequence(): number {
    return this.sequenceCounter++;
  }

  submitOrder(input: SubmitOrderInput): EngineEvent[] {
    // Sequence is assigned on intake — before validation — so the order exists
    // in the registry with a stable identity even if it is rejected.
    const sequence = this.nextSequence();
    const order: Order = {
      id: `order-${sequence}`,
      instrumentId: input.instrumentId,
      accountId: input.accountId,
      side: input.side,
      type: input.type,
      price: input.price,
      quantity: input.quantity,
      filledQuantity: 0,
      status: 'open',
      sequence,
    };
    this.orders.set(order.id, order);

    // 1. Validation — reject before touching the book.
    if (order.quantity <= 0) {
      order.status = 'rejected';
      return [
        { type: 'order_rejected', order, reason: 'quantity must be positive' },
      ];
    }
    if (order.type === 'limit' && (order.price === null || order.price <= 0)) {
      order.status = 'rejected';
      return [
        {
          type: 'order_rejected',
          order,
          reason: 'limit order requires a positive price',
        },
      ];
    }

    const events: EngineEvent[] = [];
    const restingSide: OrderSide = order.side === 'buy' ? 'sell' : 'buy';
    const limitPrice = order.type === 'limit' ? order.price : null;

    // 3. Match loop. Terminates: every iteration fully consumes at least one
    // side (min of the two remainders), so either the incoming order fills or a
    // resting order leaves the book each pass.
    while (order.filledQuantity < order.quantity) {
      const resting = this.book.peekMatchable(
        order.instrumentId,
        restingSide,
        order.accountId,
        limitPrice,
      );
      if (!resting) break;

      const matchQty = Math.min(
        order.quantity - order.filledQuantity,
        resting.quantity - resting.filledQuantity,
      );
      order.filledQuantity += matchQty;
      resting.filledQuantity += matchQty;

      const tradeSequence = this.nextSequence();
      const trade: Trade = {
        id: `trade-${tradeSequence}`,
        instrumentId: order.instrumentId,
        buyOrderId: order.side === 'buy' ? order.id : resting.id,
        sellOrderId: order.side === 'sell' ? order.id : resting.id,
        price: resting.price as number, // resting orders always carry a price
        quantity: matchQty,
        sequence: tradeSequence,
      };
      events.push({ type: 'trade', trade });

      if (resting.filledQuantity === resting.quantity) {
        resting.status = 'filled';
        this.book.removeOrder(resting.id);
        events.push({ type: 'order_filled', order: resting });
      } else {
        resting.status = 'partially_filled';
      }
    }

    // 4. Disposition of the incoming order.
    if (order.filledQuantity === order.quantity) {
      order.status = 'filled';
      events.push({ type: 'order_filled', order });
    } else if (order.type === 'limit') {
      // Remaining quantity rests at its price level (time priority preserved).
      order.status = order.filledQuantity > 0 ? 'partially_filled' : 'open';
      this.book.addOrder(order);
      events.push({ type: 'order_resting', order });
    } else if (order.filledQuantity > 0) {
      // Market order, partially filled: remainder is dropped, not rested.
      order.status = 'filled';
      events.push({ type: 'order_filled', order });
    } else {
      // Market order against an empty/ineligible book: nothing matched.
      order.status = 'rejected';
      events.push({
        type: 'order_rejected',
        order,
        reason: 'no liquidity available for market order',
      });
    }

    return events;
  }

  cancelOrder(orderId: string): EngineEvent[] {
    const order = this.orders.get(orderId);
    // Unknown id, or already in a terminal state: no-op, never throws.
    if (
      !order ||
      order.status === 'filled' ||
      order.status === 'cancelled' ||
      order.status === 'rejected'
    ) {
      return [];
    }
    this.book.removeOrder(orderId);
    order.status = 'cancelled';
    return [{ type: 'order_cancelled', order }];
  }

  // Manual sanity-check tool: current bid/ask depth for an instrument.
  getSnapshot(instrumentId: string): BookSnapshot {
    return this.book.getSnapshot(instrumentId);
  }

  getBestBid(instrumentId: string): number | undefined {
    return this.book.getBestBid(instrumentId);
  }

  getBestAsk(instrumentId: string): number | undefined {
    return this.book.getBestAsk(instrumentId);
  }
}
