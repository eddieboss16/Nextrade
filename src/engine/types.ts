// Week 1 matching engine — shared types.
//
// Price and quantity are ALWAYS integers (smallest price/quantity unit). No
// floats anywhere in this module. `price` is null only for market orders.

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type OrderStatus =
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected';

export interface Order {
  id: string;
  instrumentId: string;
  accountId: string;
  side: OrderSide;
  type: OrderType;
  price: number | null; // integer, smallest price unit. null for market orders.
  quantity: number; // integer, smallest quantity unit
  filledQuantity: number;
  status: OrderStatus;
  sequence: number; // monotonically increasing, assigned on intake — enforces time priority
}

export interface Trade {
  id: string;
  instrumentId: string;
  buyOrderId: string;
  sellOrderId: string;
  price: number; // always the resting order's price, never the incoming order's price
  quantity: number;
  sequence: number;
}

export type EngineEvent =
  | { type: 'trade'; trade: Trade }
  | { type: 'order_resting'; order: Order }
  | { type: 'order_filled'; order: Order }
  | { type: 'order_cancelled'; order: Order }
  | { type: 'order_rejected'; order: Order; reason: string };

// The caller supplies the market-facing fields; the engine assigns id, sequence,
// filledQuantity and status on intake.
export type SubmitOrderInput = Pick<
  Order,
  'instrumentId' | 'accountId' | 'side' | 'type' | 'price' | 'quantity'
>;

export interface PriceLevelSnapshot {
  price: number;
  quantity: number; // aggregated remaining (unfilled) quantity resting at this price
}

export interface BookSnapshot {
  instrumentId: string;
  bids: PriceLevelSnapshot[]; // best (highest) first
  asks: PriceLevelSnapshot[]; // best (lowest) first
}
