// Per-instrument order book storage.
//
// A single OrderBook instance multiplexes every instrument. Internally each
// instrument has two sides (bids/asks); each side is a Map from integer price
// level to a FIFO queue of resting orders (oldest at index 0). A sorted array
// of active price levels per side makes "best price" an O(1) read, and a global
// orderId -> location index makes cancel an O(1) lookup (O(depth) splice).
//
// No async, no I/O, no external dependencies — pure in-memory structure.

import type {
  Order,
  OrderSide,
  BookSnapshot,
  PriceLevelSnapshot,
} from './types';

interface InstrumentBook {
  bids: Map<number, Order[]>;
  asks: Map<number, Order[]>;
  bidPrices: number[]; // active bid levels, sorted DESCENDING (best/highest at [0])
  askPrices: number[]; // active ask levels, sorted ASCENDING (best/lowest at [0])
}

interface OrderLocation {
  instrumentId: string;
  side: OrderSide; // the side this order rests on
  price: number;
}

// Insert `price` into a sorted, duplicate-free array via binary search.
// ascending=true keeps ascending order (asks); false keeps descending (bids).
function insertPriceLevel(
  levels: number[],
  price: number,
  ascending: boolean,
): void {
  let lo = 0;
  let hi = levels.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const before = ascending ? levels[mid] < price : levels[mid] > price;
    if (before) lo = mid + 1;
    else hi = mid;
  }
  levels.splice(lo, 0, price);
}

function removePriceLevel(levels: number[], price: number): void {
  const idx = levels.indexOf(price);
  if (idx !== -1) levels.splice(idx, 1);
}

export class OrderBook {
  private books = new Map<string, InstrumentBook>();
  private orderIndex = new Map<string, OrderLocation>();

  private getOrCreateBook(instrumentId: string): InstrumentBook {
    let book = this.books.get(instrumentId);
    if (!book) {
      book = { bids: new Map(), asks: new Map(), bidPrices: [], askPrices: [] };
      this.books.set(instrumentId, book);
    }
    return book;
  }

  // Rest an order at its price level (end of the FIFO queue = time priority).
  addOrder(order: Order): void {
    if (order.price === null) {
      throw new Error('cannot rest an order with a null price');
    }
    const book = this.getOrCreateBook(order.instrumentId);
    const isBuy = order.side === 'buy';
    const levels = isBuy ? book.bids : book.asks;
    const prices = isBuy ? book.bidPrices : book.askPrices;

    let queue = levels.get(order.price);
    if (!queue) {
      queue = [];
      levels.set(order.price, queue);
      insertPriceLevel(prices, order.price, !isBuy); // asks ascending, bids descending
    }
    queue.push(order);
    this.orderIndex.set(order.id, {
      instrumentId: order.instrumentId,
      side: order.side,
      price: order.price,
    });
  }

  // Remove an order by id in O(1) index lookup + O(depth) splice. Returns the
  // removed order, or undefined if it was not resting.
  removeOrder(orderId: string): Order | undefined {
    const loc = this.orderIndex.get(orderId);
    if (!loc) return undefined;
    this.orderIndex.delete(orderId);

    const book = this.books.get(loc.instrumentId);
    if (!book) return undefined;
    const isBuy = loc.side === 'buy';
    const levels = isBuy ? book.bids : book.asks;
    const prices = isBuy ? book.bidPrices : book.askPrices;

    const queue = levels.get(loc.price);
    if (!queue) return undefined;
    const idx = queue.findIndex((o) => o.id === orderId);
    if (idx === -1) return undefined;
    const [removed] = queue.splice(idx, 1);
    if (queue.length === 0) {
      levels.delete(loc.price);
      removePriceLevel(prices, loc.price);
    }
    return removed;
  }

  // Find the next resting order the incoming order may match against, walking
  // price levels best-first, skipping same-account orders (self-trade
  // prevention) and stopping once price eligibility fails. Non-mutating.
  //
  //   restingSide     — the book side to search (opposite of the incoming side)
  //   excludeAccountId— incoming order's account; its resting orders are skipped
  //   limitPrice      — incoming limit price, or null for a market order
  peekMatchable(
    instrumentId: string,
    restingSide: OrderSide,
    excludeAccountId: string,
    limitPrice: number | null,
  ): Order | undefined {
    const book = this.books.get(instrumentId);
    if (!book) return undefined;
    const isBuySide = restingSide === 'buy';
    const levels = isBuySide ? book.bids : book.asks;
    const prices = isBuySide ? book.bidPrices : book.askPrices;

    for (const price of prices) {
      if (limitPrice !== null) {
        // Incoming buy crosses asks priced <= limit; incoming sell crosses bids
        // priced >= limit. Levels are sorted best-first, so the first miss means
        // every remaining level is strictly worse — stop.
        if (isBuySide) {
          if (limitPrice > price) break; // resting bids; sell no longer crosses
        } else {
          if (limitPrice < price) break; // resting asks; buy no longer crosses
        }
      }
      const queue = levels.get(price)!;
      for (const order of queue) {
        if (order.accountId === excludeAccountId) continue;
        return order;
      }
      // Entire level was same-account: fall through to the next level.
    }
    return undefined;
  }

  getBestBid(instrumentId: string): number | undefined {
    const book = this.books.get(instrumentId);
    if (!book || book.bidPrices.length === 0) return undefined;
    return book.bidPrices[0];
  }

  getBestAsk(instrumentId: string): number | undefined {
    const book = this.books.get(instrumentId);
    if (!book || book.askPrices.length === 0) return undefined;
    return book.askPrices[0];
  }

  // Aggregated remaining depth per price level, best-first on each side.
  getSnapshot(instrumentId: string): BookSnapshot {
    const book = this.books.get(instrumentId);
    if (!book) return { instrumentId, bids: [], asks: [] };
    return {
      instrumentId,
      bids: book.bidPrices.map((p) => aggregateLevel(book.bids, p)),
      asks: book.askPrices.map((p) => aggregateLevel(book.asks, p)),
    };
  }
}

function aggregateLevel(
  levels: Map<number, Order[]>,
  price: number,
): PriceLevelSnapshot {
  const queue = levels.get(price)!;
  let quantity = 0;
  for (const order of queue) {
    quantity += order.quantity - order.filledQuantity;
  }
  return { price, quantity };
}
