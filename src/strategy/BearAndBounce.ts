import type { DecisionContract } from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import { roundPrice } from "../lib/num.ts";
import { atr, type Bar, ema, rsi } from "./indicators.ts";

/**
 * Two deterministic RULE strategies for falling markets (ADR-040). Both buy long — the account is cash, so there is
 * no shorting — but they make money when prices fall or after they have fallen too far:
 *
 * - CRYPTO_OVERSOLD_BOUNCE_V1: a coin is stretched far below its EMA20 (or RSI14 is washed out) and today trades back
 *   above yesterday's high. Buy the reversal, stop under the recent swing low, target the EMA (mean reversion).
 * - EQUITY_INVERSE_BREAKOUT_V1: 1x inverse ETFs (SH, PSQ, RWM, BITI) rise when their index falls. When the regime is
 *   bearish and the inverse ETF breaks its prior N-day high, buy it: a short of the index without a margin account.
 *
 * Pure: no I/O, no clock. The brain supplies bars, quotes and the regime read.
 */
export const BOUNCE_ID = "CRYPTO_OVERSOLD_BOUNCE_V1";
export const INVERSE_ID = "EQUITY_INVERSE_BREAKOUT_V1";

export interface BounceParams {
  atr_period: number;
  ema_period: number;
  rsi_period: number;
  rsi_max: number; // oversold when yesterday's RSI ≤ this …
  stretch_atr: number; // … or the lowest of the last 3 closes sits this many ATRs under the EMA
  swing_lookback_days: number;
  min_stop_atr: number;
  max_stop_atr: number;
  min_target_atr: number;
  max_target_atr: number;
  max_hold_hours: number;
  prior_win_prob: number;
  conviction: number;
  crash_floor: number; // no bounce buying while a fresh crypto composite is below this (capitulation)
}

export interface InverseParams {
  lookback_days: number;
  atr_period: number;
  ema_period: number;
  atr_stop_multiple: number;
  atr_target_multiple: number;
  max_hold_hours: number;
  prior_win_prob: number;
  conviction: number;
  bear_postures: string[]; // equity postures in which index hedges may be bought
  crypto_hedges: string[]; // symbols gated on the crypto regime instead of the equity posture
}

function params<T>(d: Doctrine, id: string): T | null {
  const s = d.strategies.find((x) => x.id === id);
  return s?.params ? (s.params as unknown as T) : null;
}
export const bounceParams = (d: Doctrine) => params<BounceParams>(d, BOUNCE_ID);
export const inverseParams = (d: Doctrine) => params<InverseParams>(d, INVERSE_ID);

/** Bars that closed before the UTC day containing `now` (the last bar may still be forming). */
export function completedBars(bars: Bar[], now: number): Bar[] {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  return bars.filter((b) => b.t < dayStart);
}

export interface RuleInput {
  symbol: string;
  bars: Bar[]; // daily, oldest first
  bid: number;
  ask: number;
  now: number;
  contractId: string;
  tick: number;
}

export type Signal = { contract: DecisionContract | null; reason: string };

export interface Plan {
  arena: "CRYPTO" | "EQUITIES";
  strategy: string;
  thesis: string;
  receipts: { id: string; metric: string; value: number }[];
  bear: string;
  stop: string;
  target: string;
  maxHold: number;
  regimeTrigger: string;
  winProb: number;
  conviction: number;
  atr: number;
}

export function contractFrom(i: RuleInput, p: Plan): DecisionContract {
  const crypto = p.arena === "CRYPTO";
  return {
    contract_id: i.contractId,
    created_at: i.now,
    schema_version: 1,
    origin: "RULE",
    symbol: i.symbol,
    arena: p.arena,
    strategy_id: p.strategy,
    thesis_summary: p.thesis.slice(0, 280),
    bull_case_receipts: p.receipts.map((r) => ({
      evidence_id: r.id,
      source_skill: "technical-indicators",
      metric: r.metric,
      metric_value: r.value,
      as_of: i.now,
    })),
    bear_case_brief: p.bear,
    kill_criteria: [`Bid trades at or below ${p.stop}`, `Held longer than ${p.maxHold}h`],
    invalidation_criteria: { stop_price: p.stop, max_hold_hours: p.maxHold, regime_trigger: p.regimeTrigger },
    entry_plan: {
      zone_low: roundPrice(i.bid * 0.997, i.tick, "down"),
      zone_high: roundPrice(i.ask * 1.002, i.tick, "up"),
      urgency: "NORMAL",
      targets: [p.target],
    },
    clef_probabilities: null,
    win_prob_used: p.winProb,
    bear_lethality: 0,
    atr: p.atr,
    cost_and_fee_drag: crypto
      ? { entry_fee_bps: 15, exit_fee_bps: 25, expected_slippage_bps: 10, cognitive_cost_usd: 0 }
      : { entry_fee_bps: 0, exit_fee_bps: 1, expected_slippage_bps: 5, cognitive_cost_usd: 0 },
    proposed_conviction: p.conviction,
    models_used: [
      { role: "RULE", provider: "cortex", model: p.strategy, family: "deterministic", prompt_version: "n/a" },
    ],
  };
}

/** Oversold reversal on a crypto pair. `regimeScore` is the fresh batch composite, or null when unknown. */
export function bounceSignal(i: RuleInput & { regimeScore: number | null }, p: BounceParams): Signal {
  if (i.regimeScore !== null && i.regimeScore < p.crash_floor)
    return { contract: null, reason: `capitulation regime (score ${i.regimeScore.toFixed(0)})` };
  const done = completedBars(i.bars, i.now);
  const closes = done.map((b) => b.c);
  const a = atr(done, p.atr_period);
  const e = ema(closes, p.ema_period);
  const r = rsi(closes, p.rsi_period);
  const prev = done.at(-1);
  if (a === null || e === null || r === null || !prev || a <= 0)
    return { contract: null, reason: "not enough bars" };
  const low3 = Math.min(...closes.slice(-3));
  const stretch = (e - low3) / a;
  if (!(r <= p.rsi_max || stretch >= p.stretch_atr))
    return {
      contract: null,
      reason: `not oversold (RSI ${r.toFixed(0)}, stretch ${stretch.toFixed(2)} ATR)`,
    };
  if (!(i.bid > prev.h))
    return { contract: null, reason: `no reversal (bid ${i.bid} ≤ prior high ${prev.h})` };
  if (!(i.bid < e)) return { contract: null, reason: "already back above the EMA" };

  const swing = Math.min(...i.bars.slice(-(p.swing_lookback_days + 1)).map((b) => b.l));
  const rawStop = Math.max(Math.min(swing * 0.997, i.bid - p.min_stop_atr * a), i.bid - p.max_stop_atr * a);
  const rawTarget = Math.min(Math.max(e, i.bid + p.min_target_atr * a), i.bid + p.max_target_atr * a);
  const stop = roundPrice(rawStop, i.tick, "down");
  const target = roundPrice(rawTarget, i.tick, "up");
  if (!(Number(stop) > 0)) return { contract: null, reason: "stop would be non-positive" };
  return {
    contract: contractFrom(i, {
      arena: "CRYPTO",
      strategy: BOUNCE_ID,
      thesis: `${i.symbol} oversold (RSI ${r.toFixed(0)}, ${stretch.toFixed(1)} ATR under EMA${p.ema_period}) and reversing above yesterday's high ${prev.h}; target the EMA, invalid below ${stop}.`,
      receipts: [
        { id: "rsi", metric: `rsi_${p.rsi_period}`, value: Math.round(r * 10) / 10 },
        { id: "stretch", metric: `ema${p.ema_period}_stretch_atr`, value: Math.round(stretch * 100) / 100 },
        { id: "reversal", metric: "prior_day_high", value: prev.h },
        { id: "atr", metric: `atr_${p.atr_period}`, value: a },
      ],
      bear: "Counter-trend: falling knives can keep falling and bounces often stall under the EMA. No catalyst or court review; size is the doctrine prior only.",
      stop,
      target,
      maxHold: p.max_hold_hours,
      regimeTrigger: `crypto composite < ${p.crash_floor}`,
      winProb: p.prior_win_prob,
      conviction: p.conviction,
      atr: a,
    }),
    reason: "oversold reversal",
  };
}

/** Breakout of a 1x inverse ETF while its regime is bearish (the caller decides `bearish`). */
export function inverseSignal(i: RuleInput & { bearish: boolean; gate: string }, p: InverseParams): Signal {
  if (!i.bearish) return { contract: null, reason: `regime not bearish (${i.gate})` };
  const done = completedBars(i.bars, i.now);
  const a = atr(done, p.atr_period);
  const e = ema(
    done.map((b) => b.c),
    p.ema_period,
  );
  if (a === null || e === null || done.length < p.lookback_days || a <= 0)
    return { contract: null, reason: "not enough bars" };
  const hi = Math.max(...done.slice(-p.lookback_days).map((b) => b.h));
  if (!(i.bid > hi)) return { contract: null, reason: `no breakout (bid ${i.bid} ≤ prior high ${hi})` };
  if (!(i.bid > e)) return { contract: null, reason: "below its EMA" };
  const stop = roundPrice(i.bid - p.atr_stop_multiple * a, i.tick, "down");
  const target = roundPrice(i.bid + p.atr_target_multiple * a, i.tick, "up");
  if (!(Number(stop) > 0)) return { contract: null, reason: "stop would be non-positive" };
  return {
    contract: contractFrom(i, {
      arena: "EQUITIES",
      strategy: INVERSE_ID,
      thesis: `${i.symbol} (1x inverse) broke its ${p.lookback_days}-day high ${hi} with the regime bearish (${i.gate}): profits if the index keeps falling; invalid below ${stop}.`,
      receipts: [
        { id: "donchian", metric: `prior_high_${p.lookback_days}d`, value: hi },
        { id: "ema", metric: `ema_${p.ema_period}`, value: Math.round(e * 10_000) / 10_000 },
        { id: "atr", metric: `atr_${p.atr_period}`, value: a },
      ],
      bear: "Inverse ETFs lose when the index rebounds and decay slowly over long holds; held days, not weeks. No court review; size is the doctrine prior only.",
      stop,
      target,
      maxHold: p.max_hold_hours,
      regimeTrigger: "regime turns risk-on",
      winProb: p.prior_win_prob,
      conviction: p.conviction,
      atr: a,
    }),
    reason: "inverse breakout",
  };
}
