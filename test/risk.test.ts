import { describe, expect, it } from "vitest";
import type { DecisionContract } from "../src/contracts/decision-contract.ts";
import { evaluateBreaker } from "../src/risk/CircuitBreakerLadder.ts";
import { clearsFeeHurdle, modeledPaperCostCents, roundTripFeeRate } from "../src/risk/fees.ts";
import { edgeGate, type SizingInput, sizePosition } from "../src/risk/PositionSizer.ts";
import { type AccountView, validateEntry } from "../src/risk/PreTradeValidator.ts";
import { effectiveRung, rungForEquity } from "../src/risk/rungs.ts";
import { constitution as c, doctrine as d, doctrineWith } from "./helpers.ts";

const base: SizingInput = {
  equityUsd: 54,
  rung: d.rungs.R1,
  conviction: 7,
  pWin: 0.66,
  bearLethality: 0.4, // → D_bear = 0.1
  reputationWeight: 1,
  breakerMultiplier: 1,
  entry: 100,
  stop: 96, // 4% stop
  atr: 2,
  feeRt: 0.004,
  spreadFrac: 0.001,
  availableCashUsd: 54,
  heatRoomUsd: 54 * 0.12,
  minNotionalUsd: 1,
  minQty: 0.0001,
  qtyIncrement: 0.0001,
};

describe("PositionSizer", () => {
  it("reproduces the RISK_DOCTRINE worked example", () => {
    const r = sizePosition(base, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rEff).toBeCloseTo(0.025 * 0.7 * 0.9 * 0.64, 6);
    expect(r.dStop).toBeCloseTo(0.0445, 6);
    expect(r.binding).toBe("risk");
    expect(r.notionalUsd).toBeLessThanOrEqual((54 * r.rEff) / r.dStop);
    expect(r.notionalUsd).toBeGreaterThan(12.2);
    expect(r.riskUsd).toBeLessThanOrEqual(54 * 0.025);
  });

  it("gives zero size with no edge (p ≤ 0.5)", () => {
    expect(edgeGate(0.5, d)).toBe(0);
    const r = sizePosition({ ...base, pWin: 0.5 }, d);
    expect(r.ok).toBe(false);
  });

  it("refuses noise stops closer than min ATR multiple", () => {
    const r = sizePosition({ ...base, stop: 99 }, d);
    expect(r).toEqual({ ok: false, reasons: ["stop closer than 1.2×ATR"] });
  });

  it("is capped by concentration, cash and heat", () => {
    const wide = { ...base, conviction: 10, pWin: 0.9, bearLethality: 0, stop: 97, atr: 1 };
    const conc = sizePosition(wide, d);
    expect(conc.ok && conc.binding).toBe("concentration");
    const cash = sizePosition({ ...wide, availableCashUsd: 5 }, d);
    expect(cash.ok && cash.binding).toBe("cash");
    const heat = sizePosition({ ...wide, heatRoomUsd: 0.05 }, d);
    expect(heat.ok && heat.binding).toBe("heat");
  });

  it("never exceeds the per-trade risk cap (property sweep)", () => {
    for (let conv = 1; conv <= 10; conv++) {
      for (const p of [0.55, 0.65, 0.75, 0.95]) {
        for (const stopPct of [0.02, 0.05, 0.1, 0.2]) {
          const r = sizePosition(
            { ...base, conviction: conv, pWin: p, bearLethality: 0, stop: 100 * (1 - stopPct), atr: 1 },
            d,
          );
          if (r.ok) {
            expect(r.riskUsd).toBeLessThanOrEqual(54 * d.rungs.R1.per_trade_risk + 1e-9);
            expect(r.notionalUsd).toBeLessThanOrEqual(54 * d.rungs.R1.max_position_notional + 1e-9);
          }
        }
      }
    }
  });
});

describe("fees", () => {
  it("crypto round trip is maker entry + taker exit", () => {
    expect(roundTripFeeRate("CRYPTO", 18, d)).toBeCloseTo(0.004, 9);
  });
  it("equity sells pay the $0.01 regulatory minimum", () => {
    expect(roundTripFeeRate("EQUITIES", 18, d)).toBeCloseTo(0.01 / 18, 9);
  });
  it("hurdle needs 3× (fees + half spread)", () => {
    expect(clearsFeeHurdle(0.012, 0.004, 0, d).ok).toBe(true);
    expect(clearsFeeHurdle(0.011, 0.004, 0, d).ok).toBe(false);
  });
  it("paper cost model charges fee and slippage, rounded up", () => {
    const m = modeledPaperCostCents("CRYPTO", "sell", "taker", 18, d);
    expect(m.feeCents).toBe(5); // 18 × 0.25% = 4.5¢ → 5¢
    expect(m.slippageCents).toBe(2); // 18 × 10 bps = 1.8¢ → 2¢
  });
});

describe("breakers", () => {
  const at = (equity: number, extra: Partial<Parameters<typeof evaluateBreaker>[0]> = {}) =>
    evaluateBreaker(
      // day start = current equity so these cases isolate drawdown from daily loss
      {
        equityCents: equity,
        hwmCents: 10_000,
        dayStartEquityCents: equity,
        stopouts24h: 0,
        locked: false,
        ...extra,
      },
      d,
    );
  it("bands by drawdown", () => {
    expect(at(9_800).band).toBe("GREEN");
    expect(at(9_650).band).toBe("YELLOW");
    expect(at(9_650).multiplier).toBe(0.5);
    expect(at(9_300).band).toBe("ORANGE");
    expect(at(9_300).multiplier).toBe(0);
    expect(at(9_000).band).toBe("RED");
  });
  it("trips RED on daily loss, stop-out streaks, and stays RED while locked", () => {
    expect(at(9_900, { hwmCents: 9_900, dayStartEquityCents: 10_500 }).band).toBe("RED");
    expect(at(10_000, { stopouts24h: 3 }).band).toBe("RED");
    expect(at(10_000, { locked: true }).band).toBe("RED");
  });
});

describe("rungs", () => {
  it("maps equity to rung and never lets earned rung exceed equity", () => {
    expect(rungForEquity(54, d)).toBe("R1");
    expect(rungForEquity(150, d)).toBe("R2");
    expect(effectiveRung("R3", 80, d)).toBe("R1");
    expect(effectiveRung("R1", 5000, d)).toBe("R1");
  });
});

const contract: DecisionContract = {
  contract_id: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
  created_at: 0,
  schema_version: 1,
  origin: "RULE",
  symbol: "SOL/USD",
  arena: "CRYPTO",
  strategy_id: "CRYPTO_BREAKOUT_BASELINE_V1",
  thesis_summary: "SOL broke its prior 20-day high with the regime proxy risk-on; invalid below 92.",
  bull_case_receipts: [{ evidence_id: "x", source_skill: "t", metric: "m", metric_value: 1, as_of: 0 }],
  bear_case_brief: "Deterministic baseline: breakouts often fail and reverse quickly.",
  kill_criteria: ["Bid at or below 92"],
  invalidation_criteria: { stop_price: "92", max_hold_hours: 72 },
  entry_plan: { zone_low: "99.5", zone_high: "100.5", urgency: "NORMAL", targets: ["112"] },
  clef_probabilities: null,
  win_prob_used: 0.6,
  bear_lethality: 0,
  atr: 4,
  cost_and_fee_drag: {
    entry_fee_bps: 15,
    exit_fee_bps: 25,
    expected_slippage_bps: 10,
    cognitive_cost_usd: 0,
  },
  proposed_conviction: 5,
  models_used: [
    { role: "RULE", provider: "cortex", model: "x", family: "deterministic", prompt_version: "n/a" },
  ],
};

const account: AccountView = {
  account: "PAPER",
  equityUsd: 54,
  availableCashUsd: 54,
  rung: "R1",
  band: "GREEN",
  breakerMultiplier: 1,
  autonomyStop: 2,
  mode: "NORMAL",
  killed: false,
  reconciledAt: 1_000,
  ordersToday: 0,
  heldOrPendingSymbols: [],
  openSlots: 0,
  heatUsedUsd: 0,
};

const input = {
  contract,
  account,
  market: { bid: 100, ask: 100.05, quoteAt: 1_000 },
  asset: { tradable: true, fractionable: true, minQty: 0.01, qtyIncrement: 0.01, minNotionalUsd: 1 },
  reputationWeight: 1,
  now: 2_000,
};

describe("PreTradeValidator", () => {
  it("passes a clean baseline contract and sizes it", () => {
    const r = validateEntry(input, d, c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entryPrice).toBe(100);
    expect(Number(r.sizing.qty)).toBeGreaterThan(0);
    expect(r.sizing.riskUsd).toBeLessThanOrEqual(54 * 0.025);
  });

  it("fails closed on stale reconciliation, stale quotes, kill and breaker", () => {
    const reasons = (over: Partial<typeof input>) => {
      const r = validateEntry({ ...input, ...over }, d, c);
      return r.ok ? [] : r.reasons;
    };
    expect(reasons({ account: { ...account, reconciledAt: null } })).toContain(
      "broker state not reconciled recently",
    );
    expect(
      reasons({ now: 1_000 + 10 * 60_000, account: { ...account, reconciledAt: 1_000 + 10 * 60_000 } }),
    ).toContain("quote is stale");
    expect(reasons({ account: { ...account, killed: true } })).toContain("account is KILLED");
    expect(reasons({ account: { ...account, band: "RED", breakerMultiplier: 0 } })).toContain(
      "breaker RED forbids entries",
    );
    expect(reasons({ account: { ...account, mode: "REDUCE_ONLY" } })).toContain("account mode REDUCE_ONLY");
  });

  it("enforces arena, strategy enablement, slots, heat and duplicates", () => {
    const live = validateEntry({ ...input, account: { ...account, account: "LIVE" } }, d, c);
    expect(!live.ok && live.reasons).toContain("strategy not enabled for LIVE");

    const opts = validateEntry(
      { ...input, account: { ...account, account: "LIVE" }, contract: { ...contract, arena: "OPTIONS" } },
      doctrineWith((x) => {
        const s = x.strategies.find((y) => y.id === "CRYPTO_BREAKOUT_BASELINE_V1");
        if (s) s.accounts = ["PAPER", "LIVE"];
      }),
      c,
    );
    expect(!opts.ok && opts.reasons).toContain("OPTIONS not allowed on LIVE");

    const full = validateEntry({ ...input, account: { ...account, openSlots: 3 } }, d, c);
    expect(!full.ok && full.reasons).toContain("max positions (3) reached");
    const hot = validateEntry({ ...input, account: { ...account, heatUsedUsd: 54 * 0.12 } }, d, c);
    expect(!hot.ok && hot.reasons).toContain("portfolio heat budget exhausted");
    const dup = validateEntry({ ...input, account: { ...account, heldOrPendingSymbols: ["SOL/USD"] } }, d, c);
    expect(!dup.ok && dup.reasons).toContain("symbol already held or pending");
  });

  it("rejects wide spreads, chased entries and moves below the fee hurdle", () => {
    const wide = validateEntry({ ...input, market: { bid: 100, ask: 100.5, quoteAt: 1_000 } }, d, c);
    expect(!wide.ok && wide.reasons.some((x) => x.startsWith("spread"))).toBe(true);
    const chased = validateEntry({ ...input, market: { bid: 101, ask: 101.01, quoteAt: 1_000 } }, d, c);
    expect(!chased.ok && chased.reasons).toContain("price ran past the entry zone");
    const tiny = validateEntry(
      { ...input, contract: { ...contract, entry_plan: { ...contract.entry_plan, targets: ["100.6"] } } },
      d,
      c,
    );
    expect(!tiny.ok && tiny.reasons[0]?.startsWith("expected move below fee hurdle")).toBe(true);
  });
});
