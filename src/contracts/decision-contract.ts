import { z } from "zod";

/** Keystone artifact (constitution U1). No order without one. Mirrors D1 `decision_contracts`. */

const Uuid7 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const Prob = z.number().min(0).max(1);
const DecimalString = z.string().regex(/^\d+(\.\d+)?$/);

export const ReceiptSchema = z.object({
  evidence_id: z.string(),
  source_skill: z.string(),
  metric: z.string(),
  metric_value: z.union([z.number(), z.string(), z.boolean()]),
  as_of: z.number().int(),
  provenance_url: z.url().optional(),
});

export const DecisionContractSchema = z.object({
  contract_id: Uuid7,
  created_at: z.number().int(),
  schema_version: z.literal(1),
  symbol: z.string().min(1).max(32),
  arena: z.enum(["CRYPTO", "EQUITIES", "OPTIONS"]),
  strategy_id: z.string().regex(/^[A-Z0-9_]+_V\d+$/),
  thesis_summary: z.string().min(20).max(280),
  bull_case_receipts: z.array(ReceiptSchema).min(1),
  bear_case_brief: z.string().min(20).max(1200),
  kill_criteria: z.array(z.string().min(5)).min(1),
  invalidation_criteria: z.object({
    stop_price: DecimalString,
    max_hold_hours: z
      .number()
      .int()
      .positive()
      .max(24 * 30),
    regime_trigger: z.string().optional(),
  }),
  entry_plan: z.object({
    zone_low: DecimalString,
    zone_high: DecimalString,
    urgency: z.enum(["IMMEDIATE", "NORMAL", "PATIENT"]),
    targets: z.array(DecimalString).min(1).max(3),
  }),
  clef_probabilities: z.object({
    raw: z.object({ win_prob: Prob, regime_fit_prob: Prob, bear_lethality_prob: Prob }),
    calibrated_win_prob: Prob,
    composite_suitability_score: z.number().min(0).max(100),
  }),
  cost_and_fee_drag: z.object({
    entry_fee_bps: z.number().nonnegative(),
    exit_fee_bps: z.number().nonnegative(),
    expected_slippage_bps: z.number().nonnegative(),
    cognitive_cost_usd: z.literal(0), // $0 operating cost doctrine (ADR-001)
  }),
  proposed_conviction: z.number().int().min(1).max(10),
  models_used: z
    .array(
      z.object({
        role: z.enum(["TRIAGE", "STRUCTURE", "BULL", "BEAR", "SYNTH"]),
        provider: z.string(),
        model: z.string(),
        family: z.string(),
        prompt_version: z.string(),
      }),
    )
    .min(1),
});

export type DecisionContract = z.infer<typeof DecisionContractSchema>;

/**
 * Structural checks that zod can't express. Pure. Returns violations (empty = OK).
 * Note: sizing, fee hurdle and heat are NOT checked here; that is PreTradeValidator's job.
 */
export function contractViolations(c: DecisionContract): string[] {
  const v: string[] = [];
  const low = Number(c.entry_plan.zone_low);
  const high = Number(c.entry_plan.zone_high);
  const stop = Number(c.invalidation_criteria.stop_price);
  const targets = c.entry_plan.targets.map(Number);

  if (!(low > 0 && high >= low)) v.push("entry zone must satisfy 0 < low <= high");
  // Long-only (constitution: no shorting): stop below entry, targets above.
  if (!(stop < low)) v.push("stop must be below the entry zone (long-only)");
  if (targets.some((t) => !(t > high))) v.push("every target must be above the entry zone");

  const families = new Set(
    c.models_used.filter((m) => m.role === "BULL" || m.role === "BEAR").map((m) => m.family),
  );
  const hasBull = c.models_used.some((m) => m.role === "BULL");
  const hasBear = c.models_used.some((m) => m.role === "BEAR");
  if (hasBull && hasBear && families.size < 2)
    v.push("bull and bear must come from different model families");
  if (!hasBear) v.push("a bear prosecution is mandatory");

  return v;
}
