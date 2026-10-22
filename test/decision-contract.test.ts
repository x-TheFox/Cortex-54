import { describe, expect, it } from "vitest";
import {
  contractViolations,
  type DecisionContract,
  DecisionContractSchema,
} from "../src/contracts/decision-contract.ts";

const valid: DecisionContract = {
  contract_id: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
  created_at: 1_793_000_000_000,
  schema_version: 1,
  symbol: "SOL/USD",
  arena: "CRYPTO",
  strategy_id: "CRYPTO_VCP_BREAKOUT_V1",
  thesis_summary:
    "SOL breaks a 4-day volatility contraction on 2.7x volume with neutral funding; invalid below 176.",
  bull_case_receipts: [
    {
      evidence_id: "ev1",
      source_skill: "technical-indicators",
      metric: "vol_z",
      metric_value: 2.7,
      as_of: 1_793_000_000_000,
    },
  ],
  bear_case_brief:
    "Funding could flip positive fast; weekend liquidity thins; prior two breakouts failed within 24h.",
  kill_criteria: ["Close below 176 on the 4h chart", "8h funding above 0.03%"],
  invalidation_criteria: { stop_price: "176.00", max_hold_hours: 72 },
  entry_plan: { zone_low: "183.50", zone_high: "184.50", urgency: "NORMAL", targets: ["190.00", "196.00"] },
  clef_probabilities: {
    raw: { win_prob: 0.71, regime_fit_prob: 0.8, bear_lethality_prob: 0.35 },
    calibrated_win_prob: 0.58,
    composite_suitability_score: 81,
  },
  cost_and_fee_drag: {
    entry_fee_bps: 15,
    exit_fee_bps: 15,
    expected_slippage_bps: 10,
    cognitive_cost_usd: 0,
  },
  proposed_conviction: 7,
  models_used: [
    {
      role: "BULL",
      provider: "gemini",
      model: "gemini-2.5-flash",
      family: "google",
      prompt_version: "bull@1",
    },
    {
      role: "BEAR",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      family: "openai-oss",
      prompt_version: "bear@1",
    },
  ],
};

describe("DecisionContract", () => {
  it("accepts a well-formed long contract", () => {
    const parsed = DecisionContractSchema.parse(valid);
    expect(contractViolations(parsed)).toEqual([]);
  });

  it("rejects a non-UUIDv7 id", () => {
    expect(DecisionContractSchema.safeParse({ ...valid, contract_id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects any non-zero cognitive cost ($0 doctrine)", () => {
    const c = { ...valid, cost_and_fee_drag: { ...valid.cost_and_fee_drag, cognitive_cost_usd: 0.01 } };
    expect(DecisionContractSchema.safeParse(c).success).toBe(false);
  });

  it("flags a stop above entry (shorting is forbidden)", () => {
    const c = { ...valid, invalidation_criteria: { stop_price: "190.00", max_hold_hours: 72 } };
    expect(contractViolations(c)).toContain("stop must be below the entry zone (long-only)");
  });

  it("flags same-family bull and bear", () => {
    const c: DecisionContract = {
      ...valid,
      models_used: valid.models_used.map((m) => ({ ...m, family: "google" })),
    };
    expect(contractViolations(c)).toContain("bull and bear must come from different model families");
  });

  it("flags a missing bear prosecution", () => {
    const c: DecisionContract = { ...valid, models_used: valid.models_used.filter((m) => m.role !== "BEAR") };
    expect(contractViolations(c)).toContain("a bear prosecution is mandatory");
  });
});
