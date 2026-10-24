import type { DecisionContract } from "../../src/contracts/decision-contract.ts";
import type { AccountView } from "../../src/risk/PreTradeValidator.ts";

/** Shared validator fixture: a clean baseline contract on a fresh $54 PAPER account. */
export const contract: DecisionContract = {
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

export const account: AccountView = {
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

export const input = {
  contract,
  account,
  market: { bid: 100, ask: 100.05, quoteAt: 1_000 },
  asset: { tradable: true, fractionable: true, minQty: 0.01, qtyIncrement: 0.01, minNotionalUsd: 1 },
  reputationWeight: 1,
  now: 2_000,
};
