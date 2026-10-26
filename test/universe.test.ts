import { describe, expect, it } from "vitest";
import type { AlpacaAsset } from "../src/broker/types.ts";
import type { ClefApi, ClefQuestion, ClefResult } from "../src/clef/ClefClient.ts";
import type { Doctrine } from "../src/contracts/doctrine.ts";
import { Brain } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import type { AccountId } from "../src/lib/ids.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { headlineTokens, nearDuplicate, prefilter, scoreHeadline } from "../src/universe/prefilter.ts";
import { isLeveragedOrInverse, isStablecoin, normalizeSymbol, screenAsset } from "../src/universe/screen.ts";
import { constitution, doctrineWith } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

const T0 = Date.UTC(2026, 9, 26, 15, 0, 0);
const DAY = 86_400_000;

const universeOn = (mutate?: (d: Doctrine) => void) =>
  doctrineWith((d) => {
    d.universe = {
      enabled: true,
      news_scope: "all",
      max_dynamic: 3,
      ttl_days: 7,
      min_price_usd: 3,
      min_dollar_volume_usd: { CRYPTO: 1000, EQUITIES: 5_000_000 },
      max_spread_bps: { CRYPTO: 40, EQUITIES: 60 },
      max_ports_per_day: 5,
      max_watch: 4,
      prefilter_min_score: 2,
      max_open_intake_per_day: 3,
    };
    mutate?.(d);
  });

function bars(n: number, price: number, volume: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 - (n - i) * DAY,
    o: price,
    h: price * 1.02,
    l: price * 0.98,
    c: price,
    v: volume,
  }));
}

const asset = (over: Partial<AlpacaAsset> = {}): AlpacaAsset => ({
  symbol: "PLTR",
  class: "us_equity",
  tradable: true,
  fractionable: true,
  status: "active",
  min_order_size: null,
  min_trade_increment: null,
  price_increment: "0.01",
  name: "Palantir Technologies Inc. Class A Common Stock",
  exchange: "NASDAQ",
  ...over,
});

describe("universe screen (ADR-058)", () => {
  const d = universeOn();
  it("passes a liquid fractionable stock and reports its metrics", () => {
    const r = screenAsset(
      {
        symbol: "PLTR",
        arena: "EQUITIES",
        asset: asset(),
        bars: bars(40, 199, 500_000),
        quote: { bid: 199, ask: 199.1 },
      },
      d,
      constitution,
    );
    expect(r).toMatchObject({ ok: true, reasons: [] });
    expect(r.metrics.dollar_volume_usd).toBe(99_500_000);
    expect(r.metrics.spread_bps).toBeCloseTo(5, 0);
  });

  // Real Alpaca asset names, fetched 2026-10-26
  it.each([
    ["SOXL", "Direxion Daily Semiconductor Bull 3X ETF", true],
    ["TQQQ", "ProShares UltraPro QQQ", true],
    ["SQQQ", "ProShares UltraPro Short QQQ", true],
    ["UVXY", "ProShares Ultra VIX Short-Term Futures ETF", true],
    ["BITX", "2x Bitcoin ETF", true],
    ["SH", "ProShares Short S&P500", false], // constitution's 1x inverse list (ADR-040)
    ["NVDA", "NVIDIA Corporation Common Stock", false],
    ["GME", "GameStop Corp. Class A", false],
  ])("leveraged/inverse detection: %s", (sym, name, expected) => {
    expect(isLeveragedOrInverse(sym, name, constitution)).toBe(expected);
  });

  it("refuses leveraged products, OTC, non-fractionable, thin, wide, cheap, unknown — fail closed", () => {
    const base = {
      symbol: "X",
      arena: "EQUITIES" as const,
      bars: bars(40, 50, 1_000_000),
      quote: { bid: 50, ask: 50.01 },
    };
    const why = (over: Partial<Parameters<typeof screenAsset>[0]>) =>
      screenAsset({ ...base, asset: asset(), ...over }, d, constitution).reasons.join(" | ");
    expect(why({ asset: asset({ name: "Direxion Daily Semiconductor Bull 3X ETF" }) })).toMatch(/leveraged/);
    expect(why({ asset: asset({ exchange: "OTC" }) })).toMatch(/exchange OTC/);
    expect(why({ asset: asset({ fractionable: false }) })).toMatch(/not fractionable/);
    expect(why({ asset: asset({ name: null }) })).toMatch(/no asset name/);
    expect(why({ asset: null })).toMatch(/no asset record/);
    expect(why({ bars: bars(40, 50, 10) })).toMatch(/dollar volume/);
    expect(why({ bars: bars(40, 1.25, 10_000_000) })).toMatch(/below \$3/);
    expect(why({ bars: bars(12, 50, 1_000_000) })).toMatch(/only 12 daily bars/);
    expect(why({ quote: { bid: 50, ask: 51 } })).toMatch(/spread/);
    expect(why({ quote: undefined })).toMatch(/no two-sided quote/);
  });

  it("crypto: stablecoins out, Alpaca-venue volume thresholds", () => {
    expect(isStablecoin("USDT/USD")).toBe(true);
    expect(isStablecoin("PAXG/USD")).toBe(false);
    const ok = screenAsset(
      {
        symbol: "HYPE/USD",
        arena: "CRYPTO",
        asset: asset({ symbol: "HYPE/USD", class: "crypto", name: "Hyperliquid", exchange: "CRYPTO" }),
        bars: bars(40, 40, 200),
        quote: { bid: 40, ask: 40.05 },
      },
      d,
      constitution,
    );
    expect(ok.ok).toBe(true);
    const stable = screenAsset(
      {
        symbol: "USDC/USD",
        arena: "CRYPTO",
        asset: asset({ class: "crypto" }),
        bars: bars(40, 1, 1e6),
        quote: { bid: 1, ask: 1 },
      },
      d,
      constitution,
    );
    expect(stable.reasons).toContain("stablecoin");
  });

  it("normalizes news and operator symbols", () => {
    expect(normalizeSymbol("BTCUSD")).toEqual({ symbol: "BTC/USD", arena: "CRYPTO" });
    expect(normalizeSymbol("hype/usd")).toEqual({ symbol: "HYPE/USD", arena: "CRYPTO" });
    expect(normalizeSymbol("brk.b")).toEqual({ symbol: "BRK.B", arena: "EQUITIES" });
    expect(normalizeSymbol("BTC/USDT")).toBeNull(); // only USD pairs trade
    expect(normalizeSymbol("TOOLONG")).toBeNull();
  });
});

describe("Tier 0.5 prefilter (ADR-058)", () => {
  const ctx = (priority: string[] = []) => ({ priority: new Set(priority), recent: [], minScore: 2 });
  const it1 = (headline: string, symbols = ["ACME"], summary = "") => ({
    headline,
    summary,
    symbols,
    source: "benzinga",
  });

  it("drops law-firm alerts, conference notices and dividends; keeps real catalysts", () => {
    expect(
      prefilter(
        it1("INVESTOR ALERT: Pomerantz Law Firm Investigates Claims On Behalf of Investors of ACME"),
        ctx(),
      ).pass,
    ).toBe(false);
    expect(prefilter(it1("ACME to Present at the Goldman Sachs Communacopia Conference"), ctx()).pass).toBe(
      false,
    );
    expect(prefilter(it1("ACME Declares Quarterly Cash Dividend"), ctx()).pass).toBe(false);
    expect(prefilter(it1("ACME to acquire Widgets Corp for $2.1 billion in cash"), ctx()).pass).toBe(true);
    expect(prefilter(it1("ACME raises full-year guidance after record quarter"), ctx()).pass).toBe(true);
    expect(prefilter(it1("FDA approves ACME's lead drug for psoriasis"), ctx()).pass).toBe(true);
  });

  it("core/held/watched symbols always pass; roundups and near-duplicates don't", () => {
    expect(prefilter(it1("ACME Declares Quarterly Cash Dividend"), ctx(["ACME"])).pass).toBe(true);
    const many = it1("Stocks moving in Tuesday's session", ["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    expect(prefilter(many, ctx()).pass).toBe(false);
    const a = headlineTokens("ACME to acquire Widgets Corp for $2.1 billion in cash");
    const b = headlineTokens("ACME To Acquire Widgets Corp. For $2.1 Billion Cash Deal");
    expect(nearDuplicate(a, b)).toBe(true);
    expect(
      prefilter(it1("ACME to acquire Widgets Corp for $2.1 billion in cash"), { ...ctx(), recent: [b] }).why,
    ).toMatch(/near-duplicate/);
  });

  it("single-company stories score above roundups", () => {
    expect(scoreHeadline(it1("ACME jumps after upgrade"))).toBeGreaterThan(
      scoreHeadline(it1("ACME jumps after upgrade", ["A", "B", "C", "D", "E", "F"])),
    );
  });
});

/** Tier 1 promotes everything; Tier 2 passes everything (the universe path is what's under test). */
class PromoteAll implements ClefApi {
  async run(
    model: "clef-flash" | "clef",
    _s: unknown,
    questions: Record<string, ClefQuestion>,
  ): Promise<ClefResult> {
    const answers: ClefResult["answers"] = {};
    for (const id of Object.keys(questions)) {
      if (id.endsWith("material")) answers[id] = { type: "noul", noul: 0.95 };
      if (id.endsWith("direction"))
        answers[id] = { type: "choice", choice: "up", probabilities: { up: 0.9, down: 0.05, unclear: 0.05 } };
      if (id.endsWith("escalate")) answers[id] = { type: "score", score: 2.8 };
    }
    return { model, answers, usage: { input_tokens: 500, output_tokens: 0 } };
  }
}

function setup(d: Doctrine) {
  let now = T0;
  const clock = () => now;
  const market = new Market(clock);
  market.bars["BTC/USD"] = bars(40, 100, 1000);
  market.bars.PLTR = bars(40, 199, 500_000);
  market.set("PLTR", 199, 199.1);
  market.bars.SOXL = bars(40, 40, 5_000_000);
  market.set("SOXL", 40, 40.01);
  market.assets.SOXL = { name: "Direxion Daily Semiconductor Bull 3X ETF", exchange: "ARCA" };
  const paper = new FakeBroker(market, 54, clock);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const d1 = memoryD1();
  const notifier = new NullNotifier();
  const brokers: Partial<Record<AccountId, FakeBroker>> = { PAPER: paper };
  const brain = new Brain({
    sql,
    d,
    c: constitution,
    brokers,
    market: new FakeMarketData(market),
    notifier,
    d1,
    readKillFlag: async () => false,
    now: clock,
    clef: new PromoteAll(),
  });
  brain.init({ test: true });
  return {
    brain,
    sql,
    d1,
    market,
    advance(ms: number) {
      now += ms;
      market.touch();
    },
  };
}

const news = (id: string, headline: string, symbols: string[]) => ({
  id,
  createdAt: T0 - 60_000,
  headline,
  summary: "",
  symbols,
  source: "benzinga",
  url: null,
});

describe("scout: universe-wide intake and hot-porting (ADR-058)", () => {
  it("reads the whole wire, prefilters noise, and hot-ports a liquid stock that got a catalyst", async () => {
    const t = setup(universeOn());
    t.market.news.push(
      news("1", "Palantir wins $1.2 billion Army contract", ["PLTR"]),
      news("2", "SHAREHOLDER ALERT: Rosen Law Firm reminds investors of class action deadline", ["ZZZ"]),
      news("3", "Palantir wins $1.2 billion Army contract (syndicated)", ["PLTR"]),
    );
    const r = await t.brain.pulse();
    expect(r.newsQueued).toBe(1); // law-firm spam and the syndicated duplicate were prefiltered
    const row = t.sql.exec("SELECT symbol, status, source FROM universe")[0];
    expect(row).toEqual({ symbol: "PLTR", status: "TRADE", source: "scout" });
    // past the port, the candidate met the normal gates (no fresh equity posture batch → refused, fail closed)
    expect(
      t.d1.db.prepare("SELECT reason_codes FROM rejections WHERE candidate_id = 'news:1'").get(),
    ).toEqual({
      reason_codes: '["equity posture stale"]',
    });
    expect(t.brain.universe.resolve(["PLTR"], T0)).toEqual({
      symbol: "PLTR",
      arena: "EQUITIES",
      dynamic: true,
    });
  });

  it("refuses to port a leveraged ETF, and caches the refusal for a day", async () => {
    const t = setup(universeOn());
    t.market.news.push(news("1", "Semiconductor ETF surges as chip rally broadens to record", ["SOXL"]));
    await t.brain.pulse();
    expect(t.sql.exec("SELECT status FROM universe WHERE symbol = 'SOXL'")[0]).toEqual({
      status: "REJECTED",
    });
    const why = t.d1.db
      .prepare("SELECT reason_codes FROM rejections WHERE candidate_id = 'news:1'")
      .get() as {
      reason_codes: string;
    };
    expect(why.reason_codes).toMatch(/leveraged, inverse or volatility product/);
    // second catalyst the same day: no re-screen (cached)
    t.market.news.push({
      ...news("2", "SOXL jumps after chip makers raise guidance", ["SOXL"]),
      createdAt: T0,
    });
    t.advance(60_000);
    await t.brain.pulse();
    const ports = t.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key LIKE '%ports%'");
    expect(ports.map((p) => p.value)).toEqual(["1"]);
  });

  it("caps open (non-priority) intake per day; watchlist symbols always get in", async () => {
    const t = setup(universeOn((d) => (d.universe.max_open_intake_per_day = 1)));
    t.market.news.push(
      news("1", "Acme to acquire Widgets for $2 billion", ["ACME"]),
      news("2", "Globex raises full-year guidance on record demand", ["GLBX"]),
      news("3", "Bitcoin ETF inflows hit a record", ["BTCUSD"]),
    );
    const r = await t.brain.pulse();
    expect(r.newsQueued).toBe(2); // ACME (the one open slot) + BTC (core)
  });

  it("dynamic stocks need a whole-market earnings calendar (fail closed)", async () => {
    const t = setup(universeOn());
    t.market.news.push(news("1", "Palantir wins $1.2 billion Army contract", ["PLTR"]));
    await t.brain.pulse();
    const guard = (
      t.brain as unknown as { entryGuards: (a: AccountId, k: unknown, n: number) => Promise<string | null> }
    ).entryGuards;
    const contract = { arena: "EQUITIES", symbol: "PLTR" };
    t.sql.exec(
      "INSERT INTO settings (key, value, updated_at) VALUES ('earnings_as_of', ?, ?)",
      String(T0),
      T0,
    );
    expect(await guard.call(t.brain, "PAPER", contract, T0)).toMatch(/doesn't cover hot-ported stocks/);
    t.sql.exec("INSERT INTO settings (key, value, updated_at) VALUES ('earnings_coverage', 'all', ?)", T0);
    expect(await guard.call(t.brain, "PAPER", contract, T0)).toBeNull();
  });

  it("research-named related symbols are watched; the cap holds; expiry cleans up unheld rows", () => {
    const t = setup(universeOn());
    const added = t.brain.universe.watch(
      ["AMD", "HOOD", "SOFI", "RKLB", "IONQ", "BTCUSD"],
      "related:PLTR",
      T0,
    );
    expect(added).toEqual(["HOOD", "SOFI", "RKLB", "IONQ"]); // AMD and BTC are core; cap is 4
    expect(t.brain.universe.watched(T0)).toHaveLength(4);
    t.brain.universe.compact(T0 + 8 * DAY);
    expect(t.brain.universe.watched(T0 + 8 * DAY)).toHaveLength(0);
  });

  it("with the universe off, intake and resolution behave exactly as before", async () => {
    const t = setup(doctrineWith((d) => (d.universe.enabled = false)));
    t.market.news.push(news("1", "Palantir wins $1.2 billion Army contract", ["PLTR"]));
    const r = await t.brain.pulse();
    expect(r.newsQueued).toBe(0);
    expect(t.sql.exec("SELECT * FROM universe")).toEqual([]);
  });
});
