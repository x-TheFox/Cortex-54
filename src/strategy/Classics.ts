import type { Doctrine } from "../contracts/doctrine.ts";
import { roundPrice } from "../lib/num.ts";
import { completedBars, contractFrom, type RuleInput, type Signal } from "./BearAndBounce.ts";
import { atr, ema, rsi, sma } from "./indicators.ts";

/**
 * Strategies from docs/STRATEGY_RESEARCH.md, encoded as deterministic RULE contracts (ADR-045). They start in the LAB
 * brain only and graduate to PAPER by PR once their LAB record and backtest agree. Pure: the brain supplies data.
 *
 * - CRYPTO_TREND_V1: time-series momentum (the crypto anomaly that survives costs best). Buy coins whose 20/50/100-day
 *   returns are all positive above a rising EMA50, on a pullback to the EMA20 or a fresh 20-day high.
 * - EQUITY_RSI2_PULLBACK_V1: Connors-style index pullback. Above the 200-day average with RSI(2) < 10, buy; aim for
 *   the 5-day average.
 * - CRYPTO_TURN_OF_MONTH_V1: hold BTC/ETH over the last two and first two days of a month.
 */
export const TREND_ID = "CRYPTO_TREND_V1";
export const RSI2_ID = "EQUITY_RSI2_PULLBACK_V1";
export const TOM_ID = "CRYPTO_TURN_OF_MONTH_V1";

export interface TrendParams {
  lookbacks: number[];
  ema_fast: number;
  ema_slow: number;
  breakout_days: number;
  pullback_atr: number;
  atr_stop_multiple: number;
  atr_target_multiple: number;
  max_hold_hours: number;
  max_new_per_run: number;
  prior_win_prob: number;
  conviction: number;
}
export interface Rsi2Params {
  sma_trend: number;
  sma_exit: number;
  rsi_max: number;
  atr_stop_multiple: number;
  min_target_atr: number;
  max_hold_hours: number;
  prior_win_prob: number;
  conviction: number;
}
export interface TomParams {
  last_days: number; // enter on the last N days of a month …
  exit_day: number; // … and be out by 00:00 UTC of this day of the next month
  atr_stop_multiple: number;
  atr_target_multiple: number;
  prior_win_prob: number;
  conviction: number;
}

function params<T>(d: Doctrine, id: string): T | null {
  const s = d.strategies.find((x) => x.id === id);
  return s?.params ? (s.params as unknown as T) : null;
}
export const trendParams = (d: Doctrine) => params<TrendParams>(d, TREND_ID);
export const rsi2Params = (d: Doctrine) => params<Rsi2Params>(d, RSI2_ID);
export const tomParams = (d: Doctrine) => params<TomParams>(d, TOM_ID);

/** Strength used to rank trend candidates: the mean of the lookback returns. */
export function trendStrength(closes: number[], lookbacks: number[]): number | null {
  const last = closes.at(-1);
  if (last === undefined) return null;
  const rs: number[] = [];
  for (const n of lookbacks) {
    const past = closes.at(-1 - n);
    if (past === undefined || past <= 0) return null;
    rs.push(last / past - 1);
  }
  return rs.reduce((s, x) => s + x, 0) / rs.length;
}

export function trendSignal(i: RuleInput, p: TrendParams): Signal & { strength?: number } {
  const done = completedBars(i.bars, i.now);
  const closes = done.map((b) => b.c);
  const a = atr(done, 14);
  const fast = ema(closes, p.ema_fast);
  const slow = ema(closes, p.ema_slow);
  const slowBefore = ema(closes.slice(0, -5), p.ema_slow);
  const maxLb = Math.max(...p.lookbacks);
  if (
    a === null ||
    fast === null ||
    slow === null ||
    slowBefore === null ||
    closes.length < maxLb + 1 ||
    a <= 0
  )
    return { contract: null, reason: "not enough bars" };
  const allUp = p.lookbacks.every((n) => (closes.at(-1) as number) > (closes.at(-1 - n) as number));
  if (!allUp) return { contract: null, reason: "not in a time-series up-trend" };
  if (!(i.bid > slow && slow > slowBefore)) return { contract: null, reason: "below a rising EMA50" };
  const hi = Math.max(...done.slice(-p.breakout_days).map((b) => b.h));
  const pullback = i.bid >= fast && i.bid <= fast + p.pullback_atr * a;
  const breakout = i.bid > hi;
  if (!pullback && !breakout) return { contract: null, reason: "no pullback to EMA20 and no new high" };
  const strength = trendStrength(closes, p.lookbacks) ?? 0;
  const stop = roundPrice(i.bid - p.atr_stop_multiple * a, i.tick, "down");
  const target = roundPrice(i.bid + p.atr_target_multiple * a, i.tick, "up");
  if (!(Number(stop) > 0)) return { contract: null, reason: "stop would be non-positive" };
  return {
    strength,
    reason: breakout ? "trend breakout" : "trend pullback",
    contract: contractFrom(i, {
      arena: "CRYPTO",
      strategy: TREND_ID,
      thesis: `${i.symbol} in a time-series up-trend (${p.lookbacks.join("/")}-day returns all positive, mean ${(strength * 100).toFixed(1)}%) above a rising EMA${p.ema_slow}; ${breakout ? `new ${p.breakout_days}-day high` : `pullback to EMA${p.ema_fast}`}. Invalid below ${stop}.`,
      receipts: [
        {
          id: "trend_strength",
          metric: "mean_lookback_return",
          value: Math.round(strength * 10_000) / 10_000,
        },
        { id: "ema_slow", metric: `ema_${p.ema_slow}`, value: slow },
        { id: "atr", metric: "atr_14", value: a },
      ],
      bear: "Trend-following loses on reversals and chop; most of its profit comes from a few long runs. No court review.",
      stop,
      target,
      maxHold: p.max_hold_hours,
      regimeTrigger: `close below EMA${p.ema_slow}`,
      winProb: p.prior_win_prob,
      conviction: p.conviction,
      atr: a,
    }),
  };
}

export function rsi2Signal(i: RuleInput, p: Rsi2Params): Signal {
  const done = completedBars(i.bars, i.now);
  const closes = [...done.map((b) => b.c), i.bid]; // today's bid stands in for the close
  const a = atr(done, 14);
  const trend = sma(closes, p.sma_trend);
  const exit = sma(closes, p.sma_exit);
  const r = rsi(closes, 2);
  if (a === null || trend === null || exit === null || r === null || a <= 0)
    return { contract: null, reason: "not enough bars" };
  if (!(i.bid > trend)) return { contract: null, reason: `below the ${p.sma_trend}-day average` };
  if (!(r < p.rsi_max)) return { contract: null, reason: `RSI(2) ${r.toFixed(1)} not below ${p.rsi_max}` };
  const stop = roundPrice(i.bid - p.atr_stop_multiple * a, i.tick, "down");
  const target = roundPrice(Math.max(exit, i.bid + p.min_target_atr * a), i.tick, "up");
  return {
    reason: "rsi2 pullback",
    contract: contractFrom(i, {
      arena: "EQUITIES",
      strategy: RSI2_ID,
      thesis: `${i.symbol} pulled back (RSI(2) ${r.toFixed(1)}) inside an up-trend above its ${p.sma_trend}-day average; target the ${p.sma_exit}-day average ${exit.toFixed(2)}. Invalid below ${stop}.`,
      receipts: [
        { id: "rsi2", metric: "rsi_2", value: Math.round(r * 10) / 10 },
        { id: "sma_trend", metric: `sma_${p.sma_trend}`, value: Math.round(trend * 100) / 100 },
        { id: "atr", metric: "atr_14", value: a },
      ],
      bear: "Buying dips works in bull markets and fails in crashes; the 200-day filter only partly protects. No court review.",
      stop,
      target,
      maxHold: p.max_hold_hours,
      regimeTrigger: `close below the ${p.sma_trend}-day average`,
      winProb: p.prior_win_prob,
      conviction: p.conviction,
      atr: a,
    }),
  };
}

/** Turn-of-month window: in the last `lastDays` UTC days of a month; returns hours until the exit day. */
export function tomWindow(
  now: number,
  lastDays: number,
  exitDay: number,
): { open: boolean; holdHours: number } {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const open = d.getUTCDate() > daysInMonth - lastDays;
  const exitAt = Date.UTC(y, m + 1, exitDay);
  return { open, holdHours: Math.max(1, Math.floor((exitAt - now) / 3_600_000)) };
}

export function tomSignal(i: RuleInput, p: TomParams): Signal {
  const w = tomWindow(i.now, p.last_days, p.exit_day);
  if (!w.open) return { contract: null, reason: "outside the turn-of-month window" };
  const a = atr(completedBars(i.bars, i.now), 14);
  if (a === null || a <= 0) return { contract: null, reason: "not enough bars" };
  const stop = roundPrice(i.bid - p.atr_stop_multiple * a, i.tick, "down");
  const target = roundPrice(i.bid + p.atr_target_multiple * a, i.tick, "up");
  return {
    reason: "turn of month",
    contract: contractFrom(i, {
      arena: "CRYPTO",
      strategy: TOM_ID,
      thesis: `Turn-of-month: ${i.symbol} has historically drifted up over the last days and first days of a month; hold until day ${p.exit_day} (${w.holdHours}h). Invalid below ${stop}.`,
      receipts: [
        { id: "tom_hold", metric: "hold_hours", value: w.holdHours },
        { id: "atr", metric: "atr_14", value: a },
      ],
      bear: "A calendar effect from 2015–2021 samples; it may have faded and it does not always beat buy-and-hold.",
      stop,
      target,
      maxHold: w.holdHours,
      regimeTrigger: "none (calendar strategy)",
      winProb: p.prior_win_prob,
      conviction: p.conviction,
      atr: a,
    }),
  };
}
