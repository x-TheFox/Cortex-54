import { z } from "zod";

/**
 * Runtime schemas for every RULE strategy's doctrine `params` (audit 2026-10-24: params were blind-cast with
 * `as unknown as T`, so a typo in doctrine.yaml became NaN stops at trade time). `doctrineViolations()` checks
 * them, so a bad value now fails `config:build` — and therefore CI and deploy — instead of a live pulse.
 * Keep in sync with the `*Params` interfaces next to each strategy (a test parses the shipped doctrine).
 */
const pos = z.number().positive();
const int = z.number().int().positive();
const prob = z.number().gt(0.5).lt(1); // a rule's prior must claim *some* edge, and never certainty
const conviction = z.number().int().min(1).max(10);

export const STRATEGY_PARAMS: Record<string, z.ZodType> = {
  CRYPTO_BREAKOUT_BASELINE_V1: z.object({
    lookback_days: int,
    atr_period: int,
    atr_stop_multiple: pos,
    atr_target_multiple: pos,
    max_hold_hours: int,
    prior_win_prob: prob,
    conviction,
    regime_proxy_ema: int,
  }),
  CRYPTO_OVERSOLD_BOUNCE_V1: z
    .object({
      atr_period: int,
      ema_period: int,
      rsi_period: int,
      rsi_max: z.number().min(0).max(100),
      stretch_atr: pos,
      swing_lookback_days: int,
      min_stop_atr: pos,
      max_stop_atr: pos,
      min_target_atr: pos,
      max_target_atr: pos,
      max_hold_hours: int,
      prior_win_prob: prob,
      conviction,
      crash_floor: z.number().min(0).max(100),
    })
    .refine((p) => p.min_stop_atr <= p.max_stop_atr && p.min_target_atr <= p.max_target_atr, "min > max"),
  EQUITY_INVERSE_BREAKOUT_V1: z.object({
    instrument: z.literal("inverse_etf_1x"),
    lookback_days: int,
    atr_period: int,
    ema_period: int,
    atr_stop_multiple: pos,
    atr_target_multiple: pos,
    max_hold_hours: int,
    prior_win_prob: prob,
    conviction,
    bear_postures: z.array(z.enum(["REDUCE_ONLY", "CASH_PRIORITY"])).min(1),
    crypto_hedges: z.array(z.string()),
  }),
  CRYPTO_KRONOS_FORECAST_V1: z
    .object({
      candle_hours: int,
      lookback_hours: int,
      horizon_hours: int,
      paths: int,
      atr_stop_multiple: pos,
      atr_target_multiple: pos,
      max_hold_hours: int,
      min_p_win: z.number().gt(0.5).max(1),
      min_edge: z.number().min(-1).max(1),
      max_forecast_age_hours: pos,
      max_price_drift: z.number().positive().max(0.1),
      conviction,
      crash_floor: z.number().min(0).max(100),
    })
    .refine((p) => p.horizon_hours % p.candle_hours === 0, "horizon must be whole candles")
    .refine(
      (p) => p.lookback_hours / p.candle_hours <= 512,
      "lookback exceeds the Kronos context (512 candles)",
    ),
  CRYPTO_TREND_V1: z.object({
    lookbacks: z.array(int).min(1),
    ema_fast: int,
    ema_slow: int,
    breakout_days: int,
    pullback_atr: pos,
    atr_stop_multiple: pos,
    atr_target_multiple: pos,
    max_hold_hours: int,
    max_new_per_run: int,
    prior_win_prob: prob,
    conviction,
  }),
  EQUITY_RSI2_PULLBACK_V1: z.object({
    sma_trend: int,
    sma_exit: int,
    rsi_max: z.number().min(0).max(100),
    atr_stop_multiple: pos,
    min_target_atr: pos,
    max_hold_hours: int,
    prior_win_prob: prob,
    conviction,
  }),
  CRYPTO_TURN_OF_MONTH_V1: z.object({
    last_days: z.number().int().min(1).max(10),
    exit_day: z.number().int().min(1).max(10),
    atr_stop_multiple: pos,
    atr_target_multiple: pos,
    prior_win_prob: prob,
    conviction,
  }),
};
