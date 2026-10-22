import { z } from "zod";
import type { Bar } from "../strategy/indicators.ts";

/** Zod schemas for the Alpaca payloads we depend on. Unknown fields are stripped; missing ones fail closed. */
const Dec = z.union([z.string(), z.number()]).transform((v) => String(v));
const DecN = Dec.nullable().optional();

export const AlpacaAccountSchema = z.object({
  id: z.string(),
  status: z.string(),
  currency: z.string().optional(),
  cash: Dec,
  buying_power: Dec,
  non_marginable_buying_power: DecN,
  equity: Dec,
  last_equity: Dec,
  trading_blocked: z.boolean().optional(),
  account_blocked: z.boolean().optional(),
  multiplier: DecN,
  crypto_status: z.string().nullable().optional(),
});
export type AlpacaAccount = z.infer<typeof AlpacaAccountSchema>;

export const AlpacaPositionSchema = z.object({
  symbol: z.string(),
  asset_class: z.string(),
  qty: Dec,
  qty_available: DecN,
  avg_entry_price: Dec,
  current_price: DecN,
  market_value: DecN,
  side: z.string(),
});
export type AlpacaPosition = z.infer<typeof AlpacaPositionSchema>;

export const AlpacaOrderSchema = z.object({
  id: z.string(),
  client_order_id: z.string(),
  status: z.string(),
  symbol: z.string(),
  asset_class: z.string().optional(),
  side: z.enum(["buy", "sell"]),
  type: z.string().optional(),
  order_type: z.string().optional(),
  time_in_force: z.string(),
  qty: DecN,
  notional: DecN,
  filled_qty: Dec,
  filled_avg_price: DecN,
  limit_price: DecN,
  stop_price: DecN,
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
});
export type AlpacaOrder = z.infer<typeof AlpacaOrderSchema>;

export const AlpacaActivitySchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  transaction_time: z.string().optional(),
  date: z.string().optional(),
  type: z.string().optional(),
  price: DecN,
  qty: DecN,
  side: z.string().optional(),
  symbol: z.string().optional(),
  order_id: z.string().optional(),
  net_amount: DecN,
});
export type AlpacaActivity = z.infer<typeof AlpacaActivitySchema>;

export const AlpacaClockSchema = z.object({
  timestamp: z.string(),
  is_open: z.boolean(),
  next_open: z.string(),
  next_close: z.string(),
});
export type AlpacaClock = z.infer<typeof AlpacaClockSchema>;

export const AlpacaAssetSchema = z.object({
  symbol: z.string(),
  class: z.string(),
  tradable: z.boolean(),
  fractionable: z.boolean(),
  status: z.string(),
  min_order_size: DecN,
  min_trade_increment: DecN,
  price_increment: DecN,
});
export type AlpacaAsset = z.infer<typeof AlpacaAssetSchema>;

export const OPEN_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "partially_filled",
  "pending_cancel",
  "pending_replace",
  "held",
  "calculated",
  "stopped",
  "suspended",
]);

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "stop" | "stop_limit" | "market";
  time_in_force: "day" | "gtc" | "ioc";
  qty: string;
  limit_price?: string;
  stop_price?: string;
  client_order_id: string;
  extended_hours?: boolean;
}

export interface Quote {
  bid: number;
  ask: number;
  at: number;
}

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`Alpaca ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

/** What the brain needs from a broker account. AlpacaClient implements it; tests use a simulator. */
export interface BrokerApi {
  account(): Promise<AlpacaAccount>;
  positions(): Promise<AlpacaPosition[]>;
  openOrders(): Promise<AlpacaOrder[]>;
  orderByClientId(clientOrderId: string): Promise<AlpacaOrder | null>;
  activities(afterIso: string | null): Promise<AlpacaActivity[]>;
  submitOrder(req: OrderRequest): Promise<AlpacaOrder>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  clock(): Promise<AlpacaClock>;
  asset(symbol: string): Promise<AlpacaAsset>;
}

export interface NewsItem {
  id: string;
  createdAt: number;
  headline: string;
  summary: string;
  symbols: string[];
  source: string;
  url: string | null;
}

/** Market data (shared by both accounts; any valid key works). */
export interface MarketDataApi {
  /** Benzinga news via Alpaca (free plan), oldest first, strictly after `sinceIso`. */
  news(symbols: string[], sinceIso: string): Promise<NewsItem[]>;
  cryptoQuotes(symbols: string[]): Promise<Record<string, Quote>>;
  stockQuotes(symbols: string[]): Promise<Record<string, Quote>>;
  cryptoDailyBars(symbols: string[], days: number, now: number): Promise<Record<string, Bar[]>>;
  stockDailyBars(symbols: string[], days: number, now: number): Promise<Record<string, Bar[]>>;
}
