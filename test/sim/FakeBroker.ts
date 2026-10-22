import {
  type AlpacaAccount,
  type AlpacaActivity,
  type AlpacaAsset,
  type AlpacaClock,
  type AlpacaOrder,
  type AlpacaPosition,
  type BrokerApi,
  BrokerError,
  type MarketDataApi,
  type NewsItem,
  OPEN_ORDER_STATUSES,
  type OrderRequest,
  type Quote,
} from "../../src/broker/types.ts";
import type { Bar } from "../../src/strategy/indicators.ts";

/**
 * Small Alpaca simulator: limit / stop_limit / stop / ioc semantics, held quantity for open sells,
 * duplicate client_order_id rejection, FILL activities. Crypto only needs to be realistic enough to drive
 * the brain through every state; it is not a matching engine.
 */
interface SimOrder extends AlpacaOrder {
  triggered: boolean;
}

export class Market {
  quotes: Record<string, Quote> = {};
  news: NewsItem[] = [];
  bars: Record<string, Bar[]> = {};
  constructor(public clock: () => number) {}
  set(symbol: string, bid: number, ask: number): void {
    this.quotes[symbol] = { bid, ask, at: this.clock() };
  }
  /** Refresh quote timestamps (a live feed would). */
  touch(): void {
    for (const q of Object.values(this.quotes)) q.at = this.clock();
  }
}

export class FakeBroker implements BrokerApi {
  cash: number;
  positionsBySymbol = new Map<string, { qty: number; avg: number }>();
  orders = new Map<string, SimOrder>();
  acts: AlpacaActivity[] = [];
  lastEquity: number;
  isOpen = true;
  submitDelayMs = 0;
  failNextSubmit: string | null = null;
  calls: string[] = [];
  private seq = 0;

  constructor(
    private readonly market: Market,
    startCash: number,
    private readonly clockFn: () => number,
  ) {
    this.cash = startCash;
    this.lastEquity = startCash;
  }

  private iso(): string {
    return new Date(this.clockFn()).toISOString();
  }

  equity(): number {
    let v = this.cash;
    for (const [s, p] of this.positionsBySymbol) v += p.qty * (this.market.quotes[s]?.bid ?? p.avg);
    return v;
  }

  private heldForSells(symbol: string): number {
    let h = 0;
    for (const o of this.orders.values()) {
      if (o.symbol === symbol && o.side === "sell" && OPEN_ORDER_STATUSES.has(o.status))
        h += Number(o.qty) - Number(o.filled_qty);
    }
    return h;
  }

  async account(): Promise<AlpacaAccount> {
    this.calls.push("account");
    const eq = this.equity();
    return {
      id: "sim",
      status: "ACTIVE",
      cash: this.cash.toFixed(2),
      buying_power: this.cash.toFixed(2),
      non_marginable_buying_power: this.cash.toFixed(2),
      equity: eq.toFixed(2),
      last_equity: this.lastEquity.toFixed(2),
      trading_blocked: false,
      account_blocked: false,
      multiplier: "1",
    };
  }

  async positions(): Promise<AlpacaPosition[]> {
    this.calls.push("positions");
    return [...this.positionsBySymbol].map(([s, p]) => ({
      symbol: s.replace("/", ""),
      asset_class: "crypto",
      qty: String(p.qty),
      qty_available: String(p.qty - this.heldForSells(s)),
      avg_entry_price: String(p.avg),
      current_price: String(this.market.quotes[s]?.bid ?? p.avg),
      market_value: null,
      side: "long",
    }));
  }

  async openOrders(): Promise<AlpacaOrder[]> {
    this.calls.push("openOrders");
    return [...this.orders.values()].filter((o) => OPEN_ORDER_STATUSES.has(o.status)).map((o) => ({ ...o }));
  }

  async orderByClientId(coid: string): Promise<AlpacaOrder | null> {
    const o = [...this.orders.values()].find((x) => x.client_order_id === coid);
    return o ? { ...o } : null;
  }

  async activities(afterIso: string | null): Promise<AlpacaActivity[]> {
    this.calls.push("activities");
    return this.acts.filter((a) => !afterIso || (a.transaction_time ?? "") >= afterIso);
  }

  async submitOrder(req: OrderRequest): Promise<AlpacaOrder> {
    this.calls.push(`submit:${req.side}:${req.type}:${req.symbol}`);
    if (this.submitDelayMs >= 0) await new Promise((r) => setTimeout(r, this.submitDelayMs));
    if (this.failNextSubmit) {
      const msg = this.failNextSubmit;
      this.failNextSubmit = null;
      throw new BrokerError(403, msg, "/v2/orders");
    }
    if ([...this.orders.values()].some((o) => o.client_order_id === req.client_order_id)) {
      throw new BrokerError(422, '{"message":"client_order_id must be unique"}', "/v2/orders");
    }
    if (req.side === "sell") {
      const pos = this.positionsBySymbol.get(req.symbol);
      if (!pos || pos.qty - this.heldForSells(req.symbol) < Number(req.qty) - 1e-12) {
        throw new BrokerError(403, '{"message":"insufficient qty available for order"}', "/v2/orders");
      }
    } else {
      const notional = Number(req.qty) * Number(req.limit_price ?? 0);
      if (notional > this.cash + 1e-9)
        throw new BrokerError(403, '{"message":"insufficient balance"}', "/v2/orders");
    }
    const id = `sim-${++this.seq}`;
    const o: SimOrder = {
      id,
      client_order_id: req.client_order_id,
      status: "new",
      symbol: req.symbol,
      asset_class: "crypto",
      side: req.side,
      type: req.type,
      time_in_force: req.time_in_force,
      qty: req.qty,
      notional: null,
      filled_qty: "0",
      filled_avg_price: null,
      limit_price: req.limit_price ?? null,
      stop_price: req.stop_price ?? null,
      created_at: this.iso(),
      updated_at: this.iso(),
      triggered: false,
    };
    this.orders.set(id, o);
    this.match(o);
    if (o.time_in_force === "ioc" && o.status === "new") o.status = "canceled";
    return { ...o };
  }

  async cancelOrder(id: string): Promise<void> {
    this.calls.push(`cancel:${id}`);
    const o = this.orders.get(id);
    if (o && OPEN_ORDER_STATUSES.has(o.status)) o.status = "canceled";
  }

  async clock(): Promise<AlpacaClock> {
    return { timestamp: this.iso(), is_open: this.isOpen, next_open: this.iso(), next_close: this.iso() };
  }

  async asset(symbol: string): Promise<AlpacaAsset> {
    return {
      symbol,
      class: "crypto",
      tradable: true,
      fractionable: true,
      status: "active",
      min_order_size: "0.01",
      min_trade_increment: "0.001",
      price_increment: "0.001",
    };
  }

  /** Advance the matching engine against current quotes. */
  tick(): void {
    for (const o of this.orders.values()) if (OPEN_ORDER_STATUSES.has(o.status)) this.match(o);
  }

  private match(o: SimOrder): void {
    const q = this.market.quotes[o.symbol];
    if (!q) return;
    let price: number | null = null;
    if (o.type === "limit") {
      const lim = Number(o.limit_price);
      if (o.side === "buy" && q.ask <= lim) price = q.ask;
      if (o.side === "sell" && q.bid >= lim) price = q.bid;
    } else if (o.type === "stop_limit" || o.type === "stop") {
      if (!o.triggered && q.bid <= Number(o.stop_price)) o.triggered = true;
      if (o.triggered) {
        if (o.type === "stop") price = q.bid;
        else if (q.bid >= Number(o.limit_price)) price = q.bid;
      }
    }
    if (price === null) return;
    const qty = Number(o.qty) - Number(o.filled_qty);
    this.fill(o, qty, price);
  }

  private fill(o: SimOrder, qty: number, price: number): void {
    const pos = this.positionsBySymbol.get(o.symbol) ?? { qty: 0, avg: 0 };
    if (o.side === "buy") {
      const nq = pos.qty + qty;
      pos.avg = (pos.qty * pos.avg + qty * price) / nq;
      pos.qty = nq;
      this.cash -= qty * price;
    } else {
      pos.qty -= qty;
      this.cash += qty * price;
    }
    if (pos.qty <= 1e-12) this.positionsBySymbol.delete(o.symbol);
    else this.positionsBySymbol.set(o.symbol, pos);
    o.filled_qty = String(Number(o.filled_qty) + qty);
    o.filled_avg_price = String(price);
    o.status = "filled";
    this.acts.push({
      id: `act-${++this.seq}`,
      activity_type: "FILL",
      transaction_time: this.iso(),
      type: "fill",
      price: String(price),
      qty: String(qty),
      side: o.side,
      symbol: o.symbol,
      order_id: o.id,
      net_amount: null,
    });
  }
}

export class FakeMarketData implements MarketDataApi {
  constructor(private readonly m: Market) {}
  async news(symbols: string[], sinceIso: string): Promise<NewsItem[]> {
    const since = Date.parse(sinceIso);
    return this.m.news.filter((n) => n.createdAt > since && n.symbols.some((s) => symbols.includes(s)));
  }
  async cryptoQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    return Object.fromEntries(
      symbols.flatMap((s) => (this.m.quotes[s] ? [[s, { ...this.m.quotes[s] }]] : [])),
    );
  }
  async stockQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    return this.cryptoQuotes(symbols);
  }
  async stockDailyBars(symbols: string[]): Promise<Record<string, Bar[]>> {
    return this.cryptoDailyBars(symbols);
  }
  async cryptoDailyBars(symbols: string[]): Promise<Record<string, Bar[]>> {
    return Object.fromEntries(symbols.flatMap((s) => (this.m.bars[s] ? [[s, this.m.bars[s]]] : [])));
  }
}
