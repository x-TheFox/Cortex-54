import { describe, expect, it } from "vitest";
import type { DecisionContract } from "../src/contracts/decision-contract.ts";
import { Brain } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { coinbaseProduct, depegBps, haltedSymbols, venueGapPct } from "../src/risk/sanity.ts";
import { constitution, doctrine } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

const RSS = `<?xml version="1.0"?><rss xmlns:ndaq="http://www.nasdaqtrader.com/"><channel>
<item><title>AZTR</title><ndaq:IssueSymbol>AZTR</ndaq:IssueSymbol><ndaq:ResumptionTradeTime>14:42:53</ndaq:ResumptionTradeTime></item>
<item><title>ZZQ</title><ndaq:IssueSymbol>ZZQ</ndaq:IssueSymbol><ndaq:ResumptionTradeTime /></item>
<item><title>PLTR</title><ndaq:IssueSymbol>PLTR</ndaq:IssueSymbol><ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime></item>
</channel></rss>`;

describe("sanity parsers (ADR-067)", () => {
  it("depeg, venue gap, Coinbase ids, halted symbols", () => {
    expect(depegBps(0.9975)).toBe(25);
    expect(depegBps(null)).toBeNull();
    expect(venueGapPct(101, 100)).toBe(1);
    expect(venueGapPct(100, null)).toBeNull();
    expect(coinbaseProduct("BTC/USD")).toBe("BTC-USD");
    expect([...haltedSymbols(RSS)].sort()).toEqual(["PLTR", "ZZQ"]); // AZTR already resumed
  });
});

function setup(http: (u: string) => Promise<Response>) {
  const now = Date.UTC(2026, 9, 26, 15);
  const m = new Market(() => now);
  m.set("USDT/USD", 0.9999, 1.0001);
  m.set("USDC/USD", 0.9998, 1.0);
  m.set("BTC/USD", 100, 100.02);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const calls: string[] = [];
  const brain = new Brain({
    sql,
    d: doctrine,
    c: constitution,
    brokers: { PAPER: new FakeBroker(m, 54, () => now) },
    market: new FakeMarketData(m),
    notifier: new NullNotifier(),
    d1: memoryD1(),
    readKillFlag: async () => false,
    now: () => now,
    http: async (u) => {
      calls.push(u);
      return http(u);
    },
  });
  const veto = (k: Partial<DecisionContract>) =>
    (brain as unknown as { sanityVeto: (c: unknown, n: number) => Promise<string | null> }).sanityVeto(
      k,
      now,
    );
  return { m, veto, calls };
}

describe("sanity vetoes in the entry guards (ADR-067)", () => {
  it("crypto: depegged stablecoin or a venue gap blocks; agreement passes; the ticker is cached", async () => {
    let coinbase = 100.01;
    const t = setup(async () =>
      Response.json({ bid: String(coinbase - 0.01), ask: String(coinbase + 0.01) }),
    );
    expect(await t.veto({ arena: "CRYPTO", symbol: "BTC/USD" })).toBeNull();
    expect(await t.veto({ arena: "CRYPTO", symbol: "BTC/USD" })).toBeNull();
    expect(t.calls.filter((c) => c.includes("coinbase"))).toHaveLength(1); // 60 s cache
    coinbase = 98;
    expect(await t.veto({ arena: "CRYPTO", symbol: "BTC/USD" })).toBeNull(); // still cached
    t.m.set("USDT/USD", 0.985, 0.987);
    expect(await t.veto({ arena: "CRYPTO", symbol: "BTC/USD" })).toMatch(/USDT is 140 bps off its \$1 peg/);
  });

  it("crypto: Alpaca 2% away from Coinbase is refused", async () => {
    const t = setup(async () => Response.json({ bid: "97.99", ask: "98.01" }));
    expect(await t.veto({ arena: "CRYPTO", symbol: "BTC/USD" })).toMatch(/disagree by 2.05%/);
  });

  it("stocks: a halted symbol is refused; an unreachable feed doesn't freeze trading", async () => {
    const t = setup(async () => new Response(RSS));
    expect(await t.veto({ arena: "EQUITIES", symbol: "PLTR" })).toMatch(/halted/);
    expect(await t.veto({ arena: "EQUITIES", symbol: "AZTR" })).toBeNull();
    const down = setup(async () => new Response("no", { status: 503 }));
    expect(await down.veto({ arena: "EQUITIES", symbol: "PLTR" })).toBeNull();
  });
});
