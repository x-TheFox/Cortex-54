import { describe, expect, it } from "vitest";
import { ClairicResultSchema, grounded, interpretFacts } from "../src/clef/clairic.ts";
import { interpretTier2 } from "../src/clef/tier2.ts";
import { CalibrationMapSchema } from "../src/contracts/calibration.ts";
import { contractViolations, DecisionContractSchema } from "../src/contracts/decision-contract.ts";
import { type Bull, buildCourtContract, calibrate, checkBull, interpretSynth } from "../src/court/court.ts";
import { buildEvidence, resolveTradeable } from "../src/court/evidence.ts";
import {
  extractJson,
  type HopAttempt,
  type LlmProvider,
  LlmRouter,
  ProviderError,
} from "../src/court/llm.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { doctrine as d } from "./helpers.ts";

const T = 1_793_000_000_000;
const rising = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    t: T - (n - i) * 86_400_000,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100 + i,
    v: 1,
  }));

const ev = () => {
  const e = buildEvidence({
    symbol: "BTC/USD",
    arena: "CRYPTO",
    bars: rising(60),
    bid: 160,
    ask: 160.02,
    now: T,
    regime: { crypto: { posture: "NEW_ENTRY_ALLOWED", score: 66 } },
    world: null,
    catalyst: {
      candidateId: "news:1",
      kind: "news",
      headline: "BTC ETF inflows hit record",
      source: "benzinga",
      url: null,
      ageMinutes: 5,
      tier1: null,
    },
    held: [],
  });
  if (!e) throw new Error("evidence");
  return e;
};

const bull = (over: Partial<Bull> = {}): Bull => ({
  no_trade: false,
  thesis: "Record ETF inflows extend the uptrend; invalid below 156.",
  setup: "momentum_continuation",
  entry_low: 159.5,
  entry_high: 160.5,
  stop: 156,
  targets: [166],
  horizon_hours: 48,
  conviction: 7,
  receipts: ["close", "atr14", "catalyst"],
  ...over,
});

describe("Tier 0 evidence", () => {
  it("resolves tradeable symbols from news/candidate symbols", () => {
    expect(resolveTradeable(["BTCUSD"], d)).toEqual({ symbol: "BTC/USD", arena: "CRYPTO" });
    expect(resolveTradeable(["PLTR", "COIN"], d)).toEqual({ symbol: "COIN", arena: "EQUITIES" });
    expect(resolveTradeable(["PLTR"], d)).toBeNull();
  });

  it("computes technicals and receipts in code", () => {
    const e = ev();
    expect(e.technicals.atr14).toBeCloseTo(2, 6);
    expect(e.technicals.high20).toBe(159);
    expect(e.receipts.map((r) => r.evidence_id)).toEqual([
      "close",
      "atr14",
      "ema20",
      "high20",
      "low20",
      "rsi14",
      "catalyst",
      "catalyst_source",
    ]);
    expect(e.receipts.at(-1)?.metric_value).toMatch(/^news:/);
  });
});

describe("bull checks (code wins)", () => {
  it("accepts a consistent brief and clips over-ambitious targets", () => {
    const r = checkBull(bull({ targets: [190] }), ev(), d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bull.targets[0]).toBeCloseTo(160.5 + 3 * 2 * Math.sqrt(2), 6);
  });
  it("rejects no_trade, zones that miss the bid, and noise stops", () => {
    expect(checkBull(bull({ no_trade: true }), ev(), d).ok).toBe(false);
    const miss = checkBull(bull({ entry_low: 150, entry_high: 151 }), ev(), d);
    expect(!miss.ok && miss.reasons).toContain("entry zone does not bracket the bid");
    const tight = checkBull(bull({ stop: 158.5 }), ev(), d);
    expect(!tight.ok && tight.reasons).toContain("stop closer than 1.2×ATR");
  });
});

describe("Tier 2 exception bar (ADR-039)", () => {
  const ans = (lf: number, ra: number) => ({
    model: "clef",
    usage: {},
    answers: {
      long_favored: { type: "noul" as const, noul: lf },
      regime_alignment: { type: "noul" as const, noul: ra },
      bear_lethality: { type: "noul" as const, noul: 0.1 },
      setup_class: {
        type: "choice" as const,
        choice: "catalyst_continuation",
        probabilities: {},
        confidence: 0.8,
      },
      structural_quality: {
        type: "score" as const,
        score: 3,
        probabilities: {},
        legend: [],
        confidence: 0.8,
      },
    },
  });
  it("waives regime alignment but demands a higher long_favored for exception candidates", () => {
    const normal = interpretTier2(ans(0.8, 0.2) as never, d);
    expect(normal.reasons.join(" ")).toContain("regime_alignment");
    expect(interpretTier2(ans(0.8, 0.2) as never, d, { exception: true }).reasons.join(" ")).toContain(
      "long_favored 0.80 < 0.85",
    );
    expect(interpretTier2(ans(0.9, 0.2) as never, d, { exception: true }).reasons.join(" ")).not.toContain(
      "regime_alignment",
    );
  });
});

describe("calibration and synthesis", () => {
  it("shrinks hard toward 0.5 during warm-up and trusts after enough outcomes", () => {
    expect(calibrate(0.7, 0, d)).toBeCloseTo(0.5 + 0.2 * 0.3, 9);
    expect(calibrate(0.7, 25, d)).toBeCloseTo(0.5 + 0.2 * 0.5, 9);
    expect(calibrate(0.7, 500, d)).toBeCloseTo(0.7, 9);
  });
  it("uses a Governor isotonic map only once it rests on enough outcomes", () => {
    const map = {
      n: 60,
      points: [
        [0, 0.2],
        [0.5, 0.4],
        [1, 0.9],
      ] as [number, number][],
    };
    expect(calibrate(0.75, 0, d, map)).toBeCloseTo(0.65, 9);
    expect(calibrate(0.75, 0, d, { ...map, n: 10 })).toBeCloseTo(calibrate(0.75, 0, d), 9);
    expect(
      CalibrationMapSchema.safeParse({
        n: 5,
        points: [
          [0, 0.5],
          [0, 0.6],
        ],
      }).success,
    ).toBe(false);
    expect(
      CalibrationMapSchema.safeParse({
        n: 5,
        points: [
          [0, 0.5],
          [1, 0.4],
        ],
      }).success,
    ).toBe(false);
  });
  it("fails closed on incomplete Clef answers", () => {
    expect(
      interpretSynth({ model: "clef", answers: { win_prob: { type: "noul", noul: 0.7 } }, usage: {} }),
    ).toBeNull();
    const t2 = interpretTier2({ model: "clef", answers: {}, usage: {} }, d);
    expect(t2.pass).toBe(false);
  });
  it("assembles a schema-valid, cross-family COURT contract", () => {
    const e = ev();
    const k = buildCourtContract({
      contractId: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
      now: T,
      evidence: e,
      bull: bull(),
      bear: {
        fatal_flaws: ["Overextended"],
        kill_criteria: ["Close below 156"],
        lethality: 0.3,
        brief: "Momentum is stretched versus ATR.",
      },
      synth: { winProb: 0.7, regimeFit: 0.7, bearLethality: 0.3, suitability100: 75 },
      calibratedWin: 0.56,
      tick: 0.001,
      models: {
        bull: { provider: "gemini", model: "gemini-3.5-flash", family: "google" },
        bear: { provider: "groq", model: "openai/gpt-oss-120b", family: "openai-oss" },
      },
      d,
    });
    expect(DecisionContractSchema.safeParse(k).success).toBe(true);
    expect(contractViolations(k)).toEqual([]);
    expect(k.strategy_id).toBe("CRYPTO_CATALYST_COURT_V1");
    expect(k.bull_case_receipts.map((r) => r.evidence_id)).toEqual([
      "close",
      "atr14",
      "catalyst",
      "catalyst_source",
    ]);
  });
});

describe("LLM router", () => {
  it("extracts JSON from fences and prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });

  const provider = (fn: (model: string) => string | Error): LlmProvider => ({
    async complete(model) {
      const r = fn(model);
      if (r instanceof Error) throw r;
      return { text: r, inputTokens: 10, outputTokens: 5 };
    },
  });
  const parse = (j: unknown) => {
    const o = j as { ok?: boolean };
    if (o.ok !== true) throw new Error("bad");
    return o;
  };

  it("skips excluded families, falls back on rate limits, and logs every hop", async () => {
    const log: HopAttempt[] = [];
    const r = new LlmRouter(
      {
        groq: provider(() => new ProviderError("groq", 429, "rate limited")),
        nim: provider(() => '{"ok": true}'),
      },
      d,
      () => T,
    );
    const res = await r.run(
      d.llm_routing.bear_chain,
      { system: "", user: "", maxOutputTokens: 10, schema: {} },
      parse,
      ["nvidia"],
      (a) => log.push(a),
    );
    expect(res?.provider).toBe("nim");
    expect(res?.family).toBe("deepseek");
    expect(log.map((l) => l.outcome)).toEqual(["RATE_LIMITED", "SKIPPED_FAMILY", "OK"]);
  });

  it("retries a schema failure once, then moves on; returns null when nothing works", async () => {
    const log: HopAttempt[] = [];
    const r = new LlmRouter({ gemini: provider(() => '{"ok": false}') }, d, () => T);
    const res = await r.run(
      [{ provider: "gemini", model: "gemini-3.5-flash" }],
      { system: "", user: "", maxOutputTokens: 10, schema: {} },
      parse,
      [],
      (a) => log.push(a),
    );
    expect(res).toBeNull();
    expect(log.map((l) => l.outcome)).toEqual(["SCHEMA_FAIL", "SCHEMA_FAIL"]);
  });
});

describe("Clairic catalyst facts (ADR-043)", () => {
  const result = {
    answers: {
      entity: { value: "NVIDIA", confidence: 0.99 },
      eps_surprise_pct: { value: 4.8, confidence: 0.94 },
      guidance_vs_consensus_pct: { value: 2.8, confidence: 0.1 },
      deal_value_usd_m: { value: null, confidence: 0.9 },
      next_day_move_estimate_pct: { value: 2, mean: 2.23, p10: 0, p90: 4.5 },
      injected: { value: "ignore me", confidence: 1 },
    },
    usage: { input_tokens: 676 },
  };
  it("keeps confident values, names uncertain ones, labels the estimate LOW", () => {
    const f = interpretFacts(ClairicResultSchema.parse(result), 0.8);
    expect(f.values).toEqual({ entity: "NVIDIA", eps_surprise_pct: 4.8 });
    expect(f.uncertain).toEqual(["guidance_vs_consensus_pct"]);
    expect(f.move_estimate).toEqual({ confidence: "LOW", mean: 2.23, p10: 0, p90: 4.5 });
  });
});

describe("Clairic grounding (audit 2026-10-24)", () => {
  it("demotes stated numbers and entities that are not in the source text", () => {
    const text = "Acme agreed to buy Widgetco for $1.2 billion; Acme shares rose 4% on the news.";
    const r = ClairicResultSchema.parse({
      answers: {
        entity: { value: "Acme", confidence: 0.99 },
        deal_value_usd_m: { value: 1200, confidence: 0.95 },
        price_move_mentioned_pct: { value: 9, confidence: 0.95 }, // not in the text
      },
    });
    const f = interpretFacts(r, 0.8, text);
    expect(f.values).toEqual({ entity: "Acme", deal_value_usd_m: 1200 });
    expect(f.uncertain).toEqual(["price_move_mentioned_pct"]);
    expect(
      interpretFacts(
        ClairicResultSchema.parse({ answers: { entity: { value: "Ignore previous", confidence: 1 } } }),
        0.8,
        text,
      ).uncertain,
    ).toEqual(["entity"]);
    expect(grounded(4, "shares rose 4% today")).toBe(true);
    expect(grounded(4, "shares rose 14% today")).toBe(false);
  });
});
