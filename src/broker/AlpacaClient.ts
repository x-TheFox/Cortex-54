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
  type NewsItem,
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

const NewsRow = z.object({
  id: z.union([z.number(), z.string()]),
  created_at: z.string(),
  headline: z.string(),
  summary: z.string().optional().default(""),
  symbols: z.array(z.string()).default([]),
  source: z.string().default(""),
  url: z.string().nullable().optional(),
});

/** Untrusted text from the outside world: strip control characters and cap length (CLAUDE.md §9). */
export function cleanText(s: string, max: number): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
  );
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

  async news(symbols: string[], sinceIso: string): Promise<NewsItem[]> {
    if (symbols.length === 0) return [];
    const url =
      `${DATA_BASE}/v1beta1/news?sort=asc&limit=50&include_content=false` +
      `&start=${encodeURIComponent(sinceIso)}&symbols=${encodeURIComponent(symbols.join(","))}`;
    const body = await call(this.fetcher, this.guard, this.creds, url, z.object({ news: z.array(NewsRow) }));
    return body.news.map((n) => ({
      id: String(n.id),
      createdAt: Date.parse(n.created_at),
      headline: cleanText(n.headline, 300),
      summary: cleanText(n.summary, 600),
      symbols: n.symbols.slice(0, 12),
      source: cleanText(n.source, 40),
      url: n.url && /^https:\/\//.test(n.url) ? n.url.slice(0, 300) : null,
    }));
  }

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

  async stockDailyBars(symbols: string[], days: number, now: number): Promise<Record<string, Bar[]>> {
    if (symbols.length === 0) return {};
    // Calendar days ≈ 1.5× trading days; IEX feed (free plan).
    const start = new Date(now - Math.ceil(days * 1.6 + 5) * 86_400_000).toISOString();
    return this.pagedBars(
      `${DATA_BASE}/v2/stocks/bars?timeframe=1Day&feed=iex&adjustment=split&limit=1000&sort=asc` +
        `&start=${encodeURIComponent(start)}&symbols=${encodeURIComponent(symbols.join(","))}`,
    );
  }

  async cryptoDailyBars(symbols: string[], days: number, now: number): Promise<Record<string, Bar[]>> {
    if (symbols.length === 0) return {};
    const start = new Date(now - (days + 2) * 86_400_000).toISOString();
    return this.pagedBars(
      `${DATA_BASE}/v1beta3/crypto/us/bars?timeframe=1Day&limit=1000&sort=asc` +
        `&start=${encodeURIComponent(start)}&symbols=${encodeURIComponent(symbols.join(","))}`,
    );
  }

  /**
   * Multi-symbol bars come back 1,000 rows per page across all symbols; without paging, later symbols are silently
   * cut short (the Kronos job lost six pairs this way, 2026-10-24). Each page is one subrequest; at most 6 pages.
   */
  private async pagedBars(url: string): Promise<Record<string, Bar[]>> {
    const out: Record<string, Bar[]> = {};
    const Page = z.object({
      bars: z.record(z.string(), z.array(BarRow)).nullable(),
      next_page_token: z.string().nullable().optional(),
    });
    let token: string | null = null;
    for (let page = 0; page < 6; page++) {
      const body: z.infer<typeof Page> = await call(
        this.fetcher,
        this.guard,
        this.creds,
        token ? `${url}&page_token=${encodeURIComponent(token)}` : url,
        Page,
      );
      for (const [sym, rows] of Object.entries(body.bars ?? {})) {
        const list = out[sym] ?? [];
        list.push(...rows.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
        out[sym] = list;
      }
      token = body.next_page_token ?? null;
      if (!token) break;
    }
    return out;
  }
}
