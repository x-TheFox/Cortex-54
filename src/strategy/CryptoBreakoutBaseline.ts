import type { DecisionContract } from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import { roundPrice } from "../lib/num.ts";
import { atr, type Bar, ema } from "./indicators.ts";

/**
 * CRYPTO_BREAKOUT_BASELINE_V1 — Phase 1 plumbing strategy. Deterministic, no LLM (origin RULE).
 * Long when the live bid breaks the prior N-day high, regime proxy is risk-on (BTC close > EMA), and the
 * ATR-based target clears the fee hurdle (checked again by the validator). Its job is to exercise the
 * whole execution path at minimum size on PAPER, not to make money.
 */
export const STRATEGY_ID = "CRYPTO_BREAKOUT_BASELINE_V1";

export interface BaselineParams {
  lookback_days: number;
  atr_period: number;
  atr_stop_multiple: number;
  atr_target_multiple: number;
  max_hold_hours: number;
  prior_win_prob: number;
  conviction: number;
  regime_proxy_ema: number;
}

export function baselineParams(d: Doctrine): BaselineParams | null {
  const s = d.strategies.find((x) => x.id === STRATEGY_ID);
  if (!s?.params) return null;
  return s.params as unknown as BaselineParams;
}

export function regimeProxyRiskOn(
  btcBars: Bar[],
  p: BaselineParams,
): { riskOn: boolean; close: number; ema: number } | null {
  const closes = btcBars.map((b) => b.c);
  const e = ema(closes, p.regime_proxy_ema);
  const close = closes.at(-1);
  if (e === null || close === undefined) return null;
  return { riskOn: close > e, close, ema: e };
}

export interface BaselineSignalInput {
  symbol: string;
  bars: Bar[]; // daily, oldest first; last bar may be the in-progress day
  bid: number;
  ask: number;
  regimeRiskOn: boolean;
  now: number;
  contractId: string;
  tick: number;
}

/** Returns a RULE DecisionContract or null (with a reason) — pure. */
export function baselineSignal(
  i: BaselineSignalInput,
  p: BaselineParams,
): { contract: DecisionContract | null; reason: string } {
  if (!i.regimeRiskOn) return { contract: null, reason: "regime proxy risk-off" };
  // Completed bars only (audit 2026-10-24): the forming bar used to feed the ATR, and priorHigh dropped the last
  // bar even when it was complete — now identical to the backtest lab's replay (ADR-046).
  const done = i.bars.filter((b) => b.t < Math.floor(i.now / 86_400_000) * 86_400_000);
  const a = atr(done, p.atr_period);
  const hi =
    done.length >= p.lookback_days ? Math.max(...done.slice(-p.lookback_days).map((b) => b.h)) : null;
  if (a === null || hi === null) return { contract: null, reason: "not enough bars" };
  if (!(i.bid > hi)) return { contract: null, reason: `no breakout (bid ${i.bid} ≤ prior high ${hi})` };

  const entryLow = Number(roundPrice(i.bid * 0.997, i.tick, "down"));
  const entryHigh = Number(roundPrice(i.ask * 1.002, i.tick, "up"));
  const stop = roundPrice(i.bid - p.atr_stop_multiple * a, i.tick, "down");
  const target = roundPrice(i.bid + p.atr_target_multiple * a, i.tick, "up");
  if (!(Number(stop) > 0)) return { contract: null, reason: "stop would be non-positive" };

  const contract: DecisionContract = {
    contract_id: i.contractId,
    created_at: i.now,
    schema_version: 1,
    origin: "RULE",
    symbol: i.symbol,
    arena: "CRYPTO",
    strategy_id: STRATEGY_ID,
    thesis_summary:
      `${i.symbol} bid ${i.bid} broke the prior ${p.lookback_days}-day high ${hi} with the BTC regime proxy risk-on; invalid below ${stop}.`.slice(
        0,
        280,
      ),
    bull_case_receipts: [
      {
        evidence_id: "donchian",
        source_skill: "technical-indicators",
        metric: `prior_high_${p.lookback_days}d`,
        metric_value: hi,
        as_of: i.now,
      },
      {
        evidence_id: "atr",
        source_skill: "technical-indicators",
        metric: `atr_${p.atr_period}`,
        metric_value: a,
        as_of: i.now,
      },
    ],
    bear_case_brief:
      "Deterministic baseline: breakouts often fail and reverse; no catalyst or court review. Size is the doctrine prior only.",
    kill_criteria: [`Bid trades at or below ${stop}`, `Held longer than ${p.max_hold_hours}h`],
    invalidation_criteria: {
      stop_price: stop,
      max_hold_hours: p.max_hold_hours,
      regime_trigger: "BTC close < EMA proxy",
    },
    entry_plan: {
      zone_low: String(entryLow),
      zone_high: String(entryHigh),
      urgency: "NORMAL",
      targets: [target],
    },
    clef_probabilities: null,
    win_prob_used: p.prior_win_prob,
    bear_lethality: 0,
    atr: a,
    cost_and_fee_drag: {
      entry_fee_bps: 15,
      exit_fee_bps: 25,
      expected_slippage_bps: 10,
      cognitive_cost_usd: 0,
    },
    proposed_conviction: p.conviction,
    models_used: [
      {
        role: "RULE",
        provider: "cortex",
        model: STRATEGY_ID,
        family: "deterministic",
        prompt_version: "n/a",
      },
    ],
  };
  return { contract, reason: "breakout" };
}
