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
  OPEN_ORDER_STATUSES,
  type OrderRequest,
  type Quote,
} from "../src/broker/types.ts";
import { getKV, type SqlLike, setKV } from "../src/cortex/store.ts";

/**
 * Keyless paper sandbox (ADR-064; dossier PSS-030 "zero-brokerage-key mode"). A broker simulator that fills against
 * live public crypto quotes the way Alpaca paper does (marketable limits fill at the touch, stops trigger on the bid)
 * and keeps its book in the local SQLite file, so a demo survives restarts. Crypto only (stock quotes need keys).
 * No fees are charged here; the brain's own fee and slippage model applies to paper fills as it always does.
 */
interface SimOrder extends AlpacaOrder {
  triggered?: boolean;
}
interface Book {
  cash: number;
  lastEquity: number;
  positions: Record<string, { qty: number; avg: number }>;
  orders: SimOrder[];
  acts: AlpacaActivity[];
  seq: number;
}

export class SimBroker implements BrokerApi {
  constructor(
    private readonly sql: SqlLike,
    private readonly market: Pick<MarketDataApi, "cryptoQuotes">,
    private readonly startingCash = 54,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private load(): Book {
    const raw = getKV(this.sql, "simbroker:book");
    if (raw) return JSON.parse(raw) as Book;
    return {
      cash: this.startingCash,
      lastEquity: this.startingCash,
      positions: {},
      orders: [],
      acts: [],
      seq: 0,
    };
  }
  private save(b: Book): void {
    b.orders = b.orders.filter(
      (o) =>
        OPEN_ORDER_STATUSES.has(o.status) ||
        this.now() - Date.parse(o.updated_at ?? o.created_at) < 7 * 86_400_000,
    );
    b.acts = b.acts.slice(-500);
    setKV(this.sql, "simbroker:book", JSON.stringify(b), this.now());
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Match open orders against fresh quotes (called before every read, like a live matching engine would). */
  private async tick(b: Book): Promise<void> {
    const open = b.orders.filter((o) => OPEN_ORDER_STATUSES.has(o.status));
    if (open.length === 0) return;
    const quotes: Record<string, Quote> = await this.market.cryptoQuotes([
      ...new Set(open.map((o) => o.symbol)),
    ]);
    for (const o of open) {
      const q = quotes[o.symbol];
      if (!q) continue;
      let price: number | null = null;
      const type = o.type ?? o.order_type;
      if (type === "limit") {
        const lim = Number(o.limit_price);
        if (o.side === "buy" && q.ask <= lim) price = q.ask;
        if (o.side === "sell" && q.bid >= lim) price = q.bid;
        if (price === null && o.time_in_force === "ioc") {
          o.status = "canceled";
          o.updated_at = this.iso();
        }
      } else if (type === "stop" || type === "stop_limit") {
        if (!o.triggered && q.bid <= Number(o.stop_price)) o.triggered = true;
        if (o.triggered) price = type === "stop" || q.bid >= Number(o.limit_price) ? q.bid : null;
      } else if (type === "market") price = o.side === "buy" ? q.ask : q.bid;
      if (price === null) continue;
      const qty = Number(o.qty) - Number(o.filled_qty);
      const pos = b.positions[o.symbol] ?? { qty: 0, avg: 0 };
      if (o.side === "buy") {
        if (qty * price > b.cash + 1e-9) {
          o.status = "rejected";
          o.updated_at = this.iso();
          continue;
        }
        pos.avg = (pos.qty * pos.avg + qty * price) / (pos.qty + qty);
        pos.qty += qty;
        b.cash -= qty * price;
      } else {
        const sell = Math.min(qty, pos.qty);
        pos.qty -= sell;
        b.cash += sell * price;
      }
      if (pos.qty <= 1e-12) delete b.positions[o.symbol];
      else b.positions[o.symbol] = pos;
      o.filled_qty = String(Number(o.filled_qty) + qty);
      o.filled_avg_price = String(price);
      o.status = "filled";
      o.updated_at = this.iso();
      b.acts.push({
        id: `sim-act-${++b.seq}`,
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

  private async book(): Promise<Book> {
    const b = this.load();
    await this.tick(b).catch(() => undefined);
    this.save(b);
    return b;
  }

  async account(): Promise<AlpacaAccount> {
    const b = await this.book();
    const syms = Object.keys(b.positions);
    const q = syms.length
      ? await this.market.cryptoQuotes(syms).catch(() => ({}) as Record<string, Quote>)
      : {};
    const mv = syms.reduce(
      (s, x) => s + (b.positions[x]?.qty ?? 0) * (q[x]?.bid ?? b.positions[x]?.avg ?? 0),
      0,
    );
    const equity = b.cash + mv;
    return {
      id: "sim",
      status: "ACTIVE",
      currency: "USD",
      cash: b.cash.toFixed(2),
      buying_power: b.cash.toFixed(2),
      non_marginable_buying_power: b.cash.toFixed(2),
      equity: equity.toFixed(2),
      last_equity: b.lastEquity.toFixed(2),
      trading_blocked: false,
      account_blocked: false,
      multiplier: "1",
      crypto_status: "ACTIVE",
    };
  }
  async positions(): Promise<AlpacaPosition[]> {
    const b = await this.book();
    return Object.entries(b.positions).map(([symbol, p]) => ({
      symbol: symbol.replace("/", ""),
      asset_class: "crypto",
      qty: String(p.qty),
      qty_available: String(p.qty),
      avg_entry_price: String(p.avg),
      current_price: null,
      market_value: null,
      side: "long",
    }));
  }
  async openOrders(): Promise<AlpacaOrder[]> {
    return (await this.book()).orders.filter((o) => OPEN_ORDER_STATUSES.has(o.status));
  }
  async orderByClientId(coid: string): Promise<AlpacaOrder | null> {
    return (await this.book()).orders.find((o) => o.client_order_id === coid) ?? null;
  }
  async activities(afterIso: string | null): Promise<AlpacaActivity[]> {
    const after = afterIso ? Date.parse(afterIso) : 0;
    return (await this.book()).acts.filter((a) => Date.parse(a.transaction_time ?? "") > after);
  }
  async submitOrder(req: OrderRequest): Promise<AlpacaOrder> {
    if (!req.symbol.includes("/")) throw new BrokerError(422, "sandbox trades crypto only", "/v2/orders");
    const b = this.load();
    if (b.orders.some((o) => o.client_order_id === req.client_order_id))
      throw new BrokerError(422, "client_order_id must be unique", "/v2/orders");
    const o: SimOrder = {
      id: `sim-${++b.seq}`,
      client_order_id: req.client_order_id,
      status: "new",
      symbol: req.symbol,
      asset_class: "crypto",
      side: req.side,
      type: req.type,
      order_type: req.type,
      time_in_force: req.time_in_force,
      qty: req.qty,
      notional: null,
      filled_qty: "0",
      filled_avg_price: null,
      limit_price: req.limit_price ?? null,
      stop_price: req.stop_price ?? null,
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    b.orders.push(o);
    await this.tick(b).catch(() => undefined);
    this.save(b);
    return { ...o };
  }
  async cancelOrder(id: string): Promise<void> {
    const b = this.load();
    const o = b.orders.find((x) => x.id === id);
    if (o && OPEN_ORDER_STATUSES.has(o.status)) {
      o.status = "canceled";
      o.updated_at = this.iso();
    }
    this.save(b);
  }
  async clock(): Promise<AlpacaClock> {
    const t = this.iso();
    return { timestamp: t, is_open: false, next_open: t, next_close: t };
  }
  async asset(symbol: string): Promise<AlpacaAsset> {
    return {
      symbol,
      class: "crypto",
      tradable: true,
      fractionable: true,
      status: "active",
      min_order_size: "0.000001",
      min_trade_increment: "0.000000001",
      price_increment: "0.00001",
      name: symbol,
      exchange: "CRYPTO",
    };
  }
}
