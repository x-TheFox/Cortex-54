import { z } from "zod";
import type { Bar } from "../strategy/indicators.ts";
import {
  type AlpacaAccount,
  AlpacaAccountSchema,
  type AlpacaActivity,
  AlpacaActivitySchema,
  type AlpacaAsset,
  AlpacaAssetSchema,
  type AlpacaClock,
  AlpacaClockSchema,
  type AlpacaOrder,
  AlpacaOrderSchema,
  type AlpacaPosition,
  AlpacaPositionSchema,
  type BrokerApi,
  BrokerError,
  type MarketDataApi,
  type OrderRequest,
  type Quote,
} from "./types.ts";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface AlpacaCredentials {
  keyId: string;
  secret: string;
}

/** Called before every outbound request; throws to enforce the per-invocation subrequest budget. */
export type SubrequestGuard = () => void;

const DATA_BASE = "https://data.alpaca.markets";

async function call<T>(
  fetcher: Fetcher,
  guard: SubrequestGuard,
  creds: AlpacaCredentials,
  url: string,
  schema: z.ZodType<T> | null,
  init: RequestInit = {},
): Promise<T> {
  guard();
  const res = await fetcher(url, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": creds.keyId,
      "APCA-API-SECRET-KEY": creds.secret,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  const path = new URL(url).pathname;
  if (!res.ok) throw new BrokerError(res.status, text, path);
  if (schema === null) return undefined as T;
  return schema.parse(text ? JSON.parse(text) : null);
}

/** Trading API for one Alpaca account (paper or live). */
export class AlpacaClient implements BrokerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly creds: AlpacaCredentials,
    private readonly guard: SubrequestGuard,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  private get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return call(this.fetcher, this.guard, this.creds, `${this.baseUrl}${path}`, schema);
  }

  account(): Promise<AlpacaAccount> {
    return this.get("/v2/account", AlpacaAccountSchema);
  }

  positions(): Promise<AlpacaPosition[]> {
    return this.get("/v2/positions", z.array(AlpacaPositionSchema));
  }

  openOrders(): Promise<AlpacaOrder[]> {
    return this.get("/v2/orders?status=open&limit=500&direction=asc", z.array(AlpacaOrderSchema));
  }

  async orderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      return await this.get(
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        AlpacaOrderSchema,
      );
    } catch (e) {
      if (e instanceof BrokerError && e.status === 404) return null;
      throw e;
    }
  }

  activities(afterIso: string | null): Promise<AlpacaActivity[]> {
    const after = afterIso ? `&after=${encodeURIComponent(afterIso)}` : "";
    return this.get(
      `/v2/account/activities?activity_types=FILL,CFEE&direction=asc&page_size=100${after}`,
      z.array(AlpacaActivitySchema),
    );
  }

  submitOrder(req: OrderRequest): Promise<AlpacaOrder> {
    return call(this.fetcher, this.guard, this.creds, `${this.baseUrl}/v2/orders`, AlpacaOrderSchema, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    try {
      await call(this.fetcher, this.guard, this.creds, `${this.baseUrl}/v2/orders/${brokerOrderId}`, null, {
        method: "DELETE",
      });
    } catch (e) {
      // 422: already filled/canceled — the next reconcile settles the true state.
      if (e instanceof BrokerError && (e.status === 422 || e.status === 404)) return;
      throw e;
    }
  }

  clock(): Promise<AlpacaClock> {
    return this.get("/v2/clock", AlpacaClockSchema);
  }

  asset(symbol: string): Promise<AlpacaAsset> {
    return this.get(`/v2/assets/${encodeURIComponent(symbol)}`, AlpacaAssetSchema);
  }
}

const QuoteRow = z.object({ ap: z.number(), bp: z.number(), t: z.string() });
const BarRow = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

export class AlpacaMarketData implements MarketDataApi {
  constructor(
    private readonly creds: AlpacaCredentials,
    private readonly guard: SubrequestGuard,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async cryptoQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    if (symbols.length === 0) return {};
    const url = `${DATA_BASE}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(symbols.join(","))}`;
    const body = await call(
      this.fetcher,
      this.guard,
      this.creds,
      url,
      z.object({ quotes: z.record(z.string(), QuoteRow) }),
    );
    return Object.fromEntries(
      Object.entries(body.quotes).map(([s, q]) => [s, { bid: q.bp, ask: q.ap, at: Date.parse(q.t) }]),
    );
  }

  async stockQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    if (symbols.length === 0) return {};
    const url = `${DATA_BASE}/v2/stocks/snapshots?feed=iex&symbols=${encodeURIComponent(symbols.join(","))}`;
    const body = await call(
      this.fetcher,
      this.guard,
      this.creds,
      url,
      z.record(z.string(), z.object({ latestQuote: QuoteRow.nullable().optional() }).nullable()),
    );
    const out: Record<string, Quote> = {};
    for (const [s, snap] of Object.entries(body)) {
      const q = snap?.latestQuote;
      if (q) out[s] = { bid: q.bp, ask: q.ap, at: Date.parse(q.t) };
    }
    return out;
  }

  async cryptoDailyBars(symbols: string[], days: number, now: number): Promise<Record<string, Bar[]>> {
    if (symbols.length === 0) return {};
    const start = new Date(now - (days + 2) * 86_400_000).toISOString();
    const url =
      `${DATA_BASE}/v1beta3/crypto/us/bars?timeframe=1Day&limit=1000&sort=asc` +
      `&start=${encodeURIComponent(start)}&symbols=${encodeURIComponent(symbols.join(","))}`;
    const body = await call(
      this.fetcher,
      this.guard,
      this.creds,
      url,
      z.object({ bars: z.record(z.string(), z.array(BarRow)) }),
    );
    return Object.fromEntries(
      Object.entries(body.bars).map(([s, rows]) => [
        s,
        rows.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
      ]),
    );
  }
}
