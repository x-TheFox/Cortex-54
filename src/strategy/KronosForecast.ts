import { z } from "zod";
import type { DecisionContract } from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import { roundPrice } from "../lib/num.ts";
import { atr, type Bar } from "./indicators.ts";

/**
 * CRYPTO_KRONOS_FORECAST_V1 (ADR-041). The `kronos` research job samples future 4-hour candle paths from the Kronos
 * foundation model (rescaled to realized volatility) and reports, for the exact stop/target this strategy uses, the
 * share of paths that end profitable. This module turns a fresh forecast into a RULE contract. Kronos supplies a
 * probability only; the brain calibrates it and the sizer sizes (constitution U2). Pure.
 */
export const KRONOS_ID = "CRYPTO_KRONOS_FORECAST_V1";

export const KronosForecastSchema = z.object({
  symbol: z.string().max(16),
  last: z.number().positive(),
  atr: z.number().positive(),
  vol_scale: z.number().min(0).max(20).optional(),
  paths: z.number().int().positive(),
  p_up: z.number().min(0).max(1),
  p_win: z.number().min(0).max(1),
  p_target_first: z.number().min(0).max(1),
  p_stop_first: z.number().min(0).max(1),
  exp_ret: z.number().min(-1).max(10),
  q10_ret: z.number().optional(),
  q90_ret: z.number().optional(),
});
export type KronosForecast = z.infer<typeof KronosForecastSchema>;

export const KronosPayloadSchema = z.object({
  model: z.string().max(80),
  horizon_hours: z.number().positive(),
  forecasts: z.array(KronosForecastSchema).max(40),
});

export interface KronosParams {
  candle_hours: number;
  lookback_hours: number;
  horizon_hours: number;
  paths: number;
  atr_stop_multiple: number;
  atr_target_multiple: number;
  max_hold_hours: number;
  min_p_win: number;
  min_edge: number;
  max_forecast_age_hours: number;
  max_price_drift: number;
  conviction: number;
  crash_floor: number;
}

export function kronosParams(d: Doctrine): KronosParams | null {
  const s = d.strategies.find((x) => x.id === KRONOS_ID);
  return s?.params ? (s.params as unknown as KronosParams) : null;
}

export interface KronosInput {
  symbol: string;
  bars: Bar[]; // daily, oldest first
  bid: number;
  ask: number;
  now: number;
  contractId: string;
  tick: number;
  forecast: KronosForecast & { produced_at: number; model: string };
  /** p_win after our calibration (shrunk toward 0.5 until enough outcomes exist). */
  calibratedWin: number;
  regimeScore: number | null;
}

export function kronosSignal(
  i: KronosInput,
  p: KronosParams,
): { contract: DecisionContract | null; reason: string } {
  const f = i.forecast;
  if (i.now - f.produced_at > p.max_forecast_age_hours * 3_600_000)
    return { contract: null, reason: "forecast is stale" };
  if (Math.abs(i.bid / f.last - 1) > p.max_price_drift)
    return { contract: null, reason: "price moved away from the forecast" };
  if (i.regimeScore !== null && i.regimeScore < p.crash_floor)
    return { contract: null, reason: `capitulation regime (score ${i.regimeScore.toFixed(0)})` };
  if (f.p_win < p.min_p_win) return { contract: null, reason: `p_win ${f.p_win} < ${p.min_p_win}` };
  if (!(f.exp_ret > 0)) return { contract: null, reason: "expected return not positive" };
  if (f.p_target_first - f.p_stop_first < p.min_edge)
    return { contract: null, reason: "stop more likely than target" };
  const a = atr(i.bars, 14);
  if (a === null || a <= 0) return { contract: null, reason: "not enough bars" };
  const stop = roundPrice(i.bid - p.atr_stop_multiple * a, i.tick, "down");
  const target = roundPrice(i.bid + p.atr_target_multiple * a, i.tick, "up");
  if (!(Number(stop) > 0)) return { contract: null, reason: "stop would be non-positive" };
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const receipt = (id: string, metric: string, v: number) => ({
    evidence_id: id,
    source_skill: "kronos-forecast",
    metric,
    metric_value: v,
    as_of: f.produced_at,
  });
  const contract: DecisionContract = {
    contract_id: i.contractId,
    created_at: i.now,
    schema_version: 1,
    origin: "RULE",
    symbol: i.symbol,
    arena: "CRYPTO",
    strategy_id: KRONOS_ID,
    thesis_summary:
      `Kronos: ${pct(f.p_win)} of ${f.paths} sampled ${p.horizon_hours}h paths end profitable for this trade (target first ${pct(f.p_target_first)}, stop first ${pct(f.p_stop_first)}, mean ${(f.exp_ret * 100).toFixed(2)}%); invalid below ${stop}.`.slice(
        0,
        280,
      ),
    bull_case_receipts: [
      receipt("kronos_p_win", "p_win", f.p_win),
      receipt("kronos_target_first", "p_target_first", f.p_target_first),
      receipt("kronos_exp_ret", `exp_ret_${p.horizon_hours}h`, f.exp_ret),
      {
        evidence_id: "atr",
        source_skill: "technical-indicators",
        metric: "atr_14",
        metric_value: a,
        as_of: i.now,
      },
    ],
    bear_case_brief:
      "A pattern model with no news awareness; sampled paths are rescaled to realized volatility and the probability is shrunk toward 0.5 until the Governor has graded enough of these trades.",
    kill_criteria: [`Bid trades at or below ${stop}`, `Held longer than ${p.max_hold_hours}h`],
    invalidation_criteria: {
      stop_price: stop,
      max_hold_hours: p.max_hold_hours,
      regime_trigger: `crypto composite < ${p.crash_floor}`,
    },
    entry_plan: {
      zone_low: roundPrice(i.bid * 0.997, i.tick, "down"),
      zone_high: roundPrice(i.ask * 1.002, i.tick, "up"),
      urgency: "NORMAL",
      targets: [target],
    },
    clef_probabilities: null,
    win_prob_used: i.calibratedWin,
    bear_lethality: Math.max(0, Math.min(1, f.p_stop_first)),
    atr: a,
    cost_and_fee_drag: {
      entry_fee_bps: 15,
      exit_fee_bps: 25,
      expected_slippage_bps: 10,
      cognitive_cost_usd: 0,
    },
    proposed_conviction: p.conviction,
    models_used: [
      { role: "RULE", provider: "kronos", model: f.model, family: "kronos", prompt_version: "n/a" },
    ],
  };
  return { contract, reason: "kronos forecast" };
}
