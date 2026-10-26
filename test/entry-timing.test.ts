import { describe, expect, it } from "vitest";
import type { DecisionContract } from "../src/contracts/decision-contract.ts";
import { Brain } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { buildEvidence } from "../src/court/evidence.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import type { AccountId } from "../src/lib/ids.ts";
import { uuidv7 } from "../src/lib/ids.ts";
import { lateness, usSession } from "../src/portfolio/lateness.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { constitution, doctrine } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0); // Thursday
const HOUR = 3_600_000;
const cfg = { late_atr: 0.8, mid_atr: 0.4 };

const hourly = (from: number, prices: number[], volumes?: number[]): Bar[] =>
  prices.map((p, i) => ({ t: from + i * HOUR, o: p, h: p + 0.5, l: p - 0.5, c: p, v: volumes?.[i] ?? 100 }));

describe("lateness meter (pure, ADR-060)", () => {
  it("measures the move since the headline in daily ATRs, plus pre-drift and volume", () => {
    // 24 quiet hours at 100, headline at T0 (bar opens 100), then a run to 104 with 3× volume
    const bars = [
      ...hourly(T0 - 24 * HOUR, Array(24).fill(100)),
      ...hourly(T0, [100, 101, 102, 103, 104], [300, 300, 300, 300, 300]),
    ];
    const l = lateness(bars, T0 + 10 * 60_000, 104, 5, T0 + 4.5 * HOUR, cfg);
    expect(l).toMatchObject({
      price_at_catalyst: 100,
      move_since_atr: 0.8,
      move_since_pct: 0.04,
      pre_drift_atr: 0,
      volume_ratio: 3,
      verdict: "LATE",
      minutes_since: 260,
    });
    expect(lateness(bars, T0 + 10 * 60_000, 101.5, 5, T0 + HOUR, cfg).verdict).toBe("EARLY");
    expect(lateness(bars, T0 + 10 * 60_000, 102.5, 5, T0 + HOUR, cfg).verdict).toBe("MID");
  });

  it("flags a leak: price drifted up before the headline", () => {
    const bars = hourly(
      T0 - 24 * HOUR,
      Array.from({ length: 26 }, (_, i) => 100 + i * 0.25),
    );
    expect(lateness(bars, T0, 106.5, 5, T0 + HOUR, cfg).pre_drift_atr).toBeCloseTo(1.2, 2);
  });

  it("no data → UNKNOWN, never LATE", () => {
    expect(lateness([], T0, 100, 5, T0, cfg).verdict).toBe("UNKNOWN");
    expect(lateness(hourly(T0, [100]), T0, 100, 0, T0, cfg).verdict).toBe("UNKNOWN");
  });

  it("US session labels follow New York time", () => {
    expect(usSession(T0)).toBe("PRE_MARKET"); // 12:00 UTC = 08:00 EDT
    expect(usSession(T0 + 3 * HOUR)).toBe("REGULAR");
    expect(usSession(T0 + 9 * HOUR)).toBe("AFTER_HOURS");
    expect(usSession(Date.UTC(2026, 9, 24, 15))).toBe("CLOSED"); // Saturday
  });
});

describe("temporal fact sheet (ADR-060)", () => {
  it("evidence carries today's date, weekday and session", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      t: T0 - (30 - i) * 86_400_000,
      o: 100,
      h: 101,
      l: 99,
      c: 100,
      v: 1,
    }));
    const e = buildEvidence({
      symbol: "SOL/USD",
      arena: "CRYPTO",
      bars,
      bid: 100,
      ask: 100.05,
      now: T0,
      regime: {},
      world: null,
      catalyst: {
        candidateId: "c",
        kind: "news",
        headline: "h",
        source: "s",
        url: null,
        ageMinutes: 5,
        tier1: null,
      },
      held: [],
    });
    expect(e?.today).toMatchObject({
      utc: "2026-10-22 12:00",
      weekday: "Thursday",
      us_equity_session: "PRE_MARKET",
    });
    expect(e?.today.note).toMatch(/training data/);
  });
});

function setup() {
  let now = T0;
  const clock = () => now;
  const market = new Market(clock);
  market.bars["BTC/USD"] = Array.from({ length: 30 }, (_, i) => ({
    t: T0 - (30 - i) * 86_400_000,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100 + i,
    v: 1,
  }));
  market.bars["ETH/USD"] = Array.from({ length: 30 }, (_, i) => ({
    t: T0 - (30 - i) * 86_400_000,
    o: 100,
    h: 102,
    l: 98,
    c: 100,
    v: 1,
  }));
  const paper = new FakeBroker(market, 54, clock);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const d1 = memoryD1();
  const brokers: Partial<Record<AccountId, FakeBroker>> = { PAPER: paper };
  const brain = new Brain({
    sql,
    d: doctrine,
    c: constitution,
    brokers,
    market: new FakeMarketData(market),
    notifier: new NullNotifier(),
    d1,
    readKillFlag: async () => false,
    now: clock,
  });
  brain.init({ test: true });
  return {
    brain,
    sql,
    d1,
    market,
    paper,
    advance(ms: number) {
      now += ms;
      market.touch();
    },
  };
}

function courtContract(
  symbol: string,
  zone: [number, number],
  stop: number,
  target: number,
  win = 0.65,
): DecisionContract {
  return {
    contract_id: uuidv7(T0),
    created_at: T0,
    schema_version: 1,
    origin: "COURT",
    symbol,
    arena: "CRYPTO",
    strategy_id: "CRYPTO_CATALYST_COURT_V1",
    thesis_summary: "Record inflows extend the uptrend; invalid below the stop.",
    bull_case_receipts: [
      { evidence_id: "close", source_skill: "t", metric: "close", metric_value: 100, as_of: T0 },
    ],
    bear_case_brief: "Momentum is extended versus ATR and may fade quickly.",
    kill_criteria: ["Daily close below the stop"],
    invalidation_criteria: { stop_price: String(stop), max_hold_hours: 48 },
    entry_plan: {
      zone_low: String(zone[0]),
      zone_high: String(zone[1]),
      urgency: "PATIENT",
      targets: [String(target)],
    },
    clef_probabilities: {
      raw: { win_prob: win, regime_fit_prob: 0.7, bear_lethality_prob: 0.3 },
      calibrated_win_prob: win,
      composite_suitability_score: 70,
    },
    win_prob_used: win,
    bear_lethality: 0.3,
    atr: 2,
    cost_and_fee_drag: {
      entry_fee_bps: 25,
      exit_fee_bps: 25,
      expected_slippage_bps: 5,
      cognitive_cost_usd: 0,
    },
    proposed_conviction: 7,
    models_used: [
      { role: "BULL", provider: "groq", model: "m", family: "qwen", prompt_version: "b@1" },
      { role: "BEAR", provider: "gemini", model: "g", family: "gemini", prompt_version: "x@1" },
    ],
  };
}

type Internals = {
  maybeRest: (a: AccountId, k: DecisionContract, why: string[], now: number) => Promise<string | null>;
  runResting: () => Promise<{ contracts: number; entries: number }>;
};

describe("resting convictions (ADR-060)", () => {
  it("a court contract whose price ran past the zone waits, then enters when the zone comes back", async () => {
    const t = setup();
    const k = courtContract("ETH/USD", [99, 100.5], 96, 108);
    t.brain.recordContract(k, T0);
    t.market.set("ETH/USD", 101.2, 101.25); // ran past the zone
    const b = t.brain as unknown as Internals;
    const status = await b.maybeRest("PAPER", k, ["price ran past the entry zone"], T0);
    expect(status).toMatch(/waits until/);
    expect(t.sql.exec("SELECT symbol FROM resting")).toEqual([{ symbol: "ETH/USD" }]);
    // still above the zone: nothing happens, no rejection rows
    t.advance(60_000);
    expect((await b.runResting()).entries).toBe(0);
    // pulls back into the zone → every gate runs again (inside a normal pulse) → passive entry placed
    t.advance(60_000);
    t.market.set("ETH/USD", 100.2, 100.25);
    await t.brain.pulse();
    expect(t.sql.exec("SELECT * FROM resting")).toEqual([]);
    expect([...t.paper.orders.values()].filter((o) => o.side === "buy")).toHaveLength(1);
  });

  it("only timing and slot reasons can rest; RULE contracts never rest; it expires", async () => {
    const t = setup();
    const k = courtContract("ETH/USD", [99, 100.5], 96, 108);
    t.brain.recordContract(k, T0);
    const b = t.brain as unknown as Internals;
    expect(await b.maybeRest("PAPER", k, ["spread 80.0 bps > max"], T0)).toBeNull();
    expect(
      await b.maybeRest("PAPER", { ...k, origin: "RULE" }, ["price ran past the entry zone"], T0),
    ).toBeNull();
    await b.maybeRest("PAPER", k, ["price ran past the entry zone"], T0);
    t.advance(25 * HOUR); // half of the 48 h horizon
    await b.runResting();
    expect(t.sql.exec("SELECT * FROM resting")).toEqual([]);
  });

  it("a full book releases its most stagnant position for a stronger court contract (rotation)", async () => {
    const t = setup();
    const b = t.brain as unknown as Internals;
    // three stagnant positions held 30 h of a 48 h horizon, all near entry
    for (const [sym, px] of [
      ["SOL/USD", 100],
      ["LINK/USD", 20],
      ["DOT/USD", 5],
    ] as const) {
      const id = uuidv7(T0 - 30 * HOUR);
      t.brain.recordContract(
        { ...courtContract(sym, [px * 0.99, px], px * 0.96, px * 1.08), contract_id: id },
        T0,
      );
      t.sql.exec(
        `INSERT INTO positions (account, symbol, arena, contract_id, qty, avg_entry, stop_price, target_price, fee_rt,
           opened_at, max_hold_until, state) VALUES ('PAPER', ?, 'CRYPTO', ?, '0.1', ?, ?, ?, 0.005, ?, ?, 'OPEN')`,
        sym,
        id,
        String(px),
        String(px * 0.96),
        String(px * 1.08),
        T0 - 30 * HOUR,
        T0 + 18 * HOUR,
      );
      t.paper.positionsBySymbol.set(sym, { qty: 0.1, avg: px });
      t.market.set(sym, px * (sym === "LINK/USD" ? 0.995 : 1.003), px * 1.004);
    }
    const k = courtContract("ETH/USD", [99, 100.5], 96, 108, 0.66);
    t.brain.recordContract(k, T0);
    t.market.set("ETH/USD", 100.2, 100.25);
    await t.brain.pulse(); // reconcile first: the rotation check runs the real validator
    const status = await b.maybeRest("PAPER", k, ["max positions (3) reached"], T0);
    expect(status).toMatch(/releasing stagnant LINK\/USD/); // the lowest R of the stagnant ones
    expect(
      t.sql.exec<{ symbol: string; exit_reason: string }>(
        "SELECT symbol, exit_reason FROM positions WHERE state = 'EXITING'",
      ),
    ).toEqual([{ symbol: "LINK/USD", exit_reason: "ROTATE" }]);
  });

  it("a newcomer that would fail the fee hurdle never rotates anything out (review finding)", async () => {
    const t = setup();
    const b = t.brain as unknown as Internals;
    const id = uuidv7(T0 - 30 * HOUR);
    t.brain.recordContract({ ...courtContract("LINK/USD", [19.8, 20], 19.2, 21.6), contract_id: id }, T0);
    t.sql.exec(
      `INSERT INTO positions (account, symbol, arena, contract_id, qty, avg_entry, stop_price, target_price, fee_rt,
         opened_at, max_hold_until, state) VALUES ('PAPER', 'LINK/USD', 'CRYPTO', ?, '0.5', '20', '19.2', '21.6', 0.005, ?, ?, 'OPEN')`,
      id,
      T0 - 30 * HOUR,
      T0 + 18 * HOUR,
    );
    t.paper.positionsBySymbol.set("LINK/USD", { qty: 0.5, avg: 20 });
    t.market.set("LINK/USD", 20.02, 20.04);
    t.market.set("ETH/USD", 100.2, 100.25);
    await t.brain.pulse();
    // target only 0.3% above the zone: can't clear the fee hurdle, so nothing is sold for it
    const k = courtContract("ETH/USD", [99, 100.5], 96, 100.8, 0.7);
    t.brain.recordContract(k, T0);
    const status = await b.maybeRest("PAPER", k, ["max positions (3) reached"], T0);
    expect(status).not.toMatch(/releasing/);
    expect(t.sql.exec("SELECT state FROM positions WHERE symbol = 'LINK/USD'")).toEqual([{ state: "OPEN" }]);
  });

  it("a weaker candidate never rotates anything out", async () => {
    const t = setup();
    const k = courtContract("ETH/USD", [99, 100.5], 96, 108, 0.55);
    t.brain.recordContract(k, T0);
    const status = await (t.brain as unknown as Internals).maybeRest(
      "PAPER",
      k,
      ["max positions (3) reached"],
      T0,
    );
    expect(status).not.toMatch(/releasing/);
  });
});

describe("lateness gate in Tier 0 (ADR-060)", () => {
  it("refuses a chased catalyst and keeps the numbers for grading", async () => {
    const t = setup();
    await t.brain.ingestBatch({
      schema_version: 1,
      job: "crypto-regime",
      produced_at: T0,
      run_url: null,
      items: [
        {
          skill_id: "crypto-regime-analyzer",
          version: "x",
          as_of: T0,
          inputs_sha256: "c".repeat(64),
          payload: {},
        },
      ],
      posture: {
        arena: "CRYPTO",
        posture: "NEW_ENTRY_ALLOWED",
        score: 66,
        ceiling: null,
        confidence: null,
        summary: "ok",
      },
    });
    t.market.bars["SOL/USD"] = Array.from({ length: 30 }, (_, i) => ({
      t: T0 - (30 - i) * 86_400_000,
      o: 100,
      h: 102.5,
      l: 97.5,
      c: 100,
      v: 1,
    })); // ATR 5
    t.market.hourly["SOL/USD"] = hourly(T0 - 22 * HOUR, [...Array(22).fill(100), 100, 103]);
    const evidenceFor = (bid: number) => {
      t.market.set("SOL/USD", bid, bid + 0.05);
      return (
        t.brain as unknown as {
          evidenceFor: (
            row: unknown,
            now: number,
          ) => Promise<{
            ok: boolean;
            reason?: string;
            hypothetical?: Record<string, unknown>;
            evidence?: { timing: { verdict: string } };
          }>;
        }
      ).evidenceFor(
        {
          candidate_id: "news:1",
          enqueued_at: T0,
          payload_json: JSON.stringify({
            kind: "news",
            headline: "Solana ETF approved",
            symbols: ["SOLUSD"],
            createdAt: T0 + 5 * 60_000,
            tier1: { material: 0.9, direction: "up", escalate: 2.5 },
          }),
        },
        T0 + 90 * 60_000,
      );
    };
    t.advance(90 * 60_000); // quotes are stamped with the clock
    const late = await evidenceFor(104.5);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe("late: price already moved 0.9 ATR since the headline (lateness meter)");
    expect(late.hypothetical?.timing).toMatchObject({ verdict: "LATE", price_at_catalyst: 100 });
    const early = await evidenceFor(101);
    expect(early.ok).toBe(true);
    expect(early.evidence?.timing.verdict).toBe("EARLY");
  });
});
