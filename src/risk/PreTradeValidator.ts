import type { Constitution } from "../contracts/constitution.ts";
import { contractViolations, type DecisionContract } from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import type { AccountId } from "../lib/ids.ts";
import type { Band } from "./CircuitBreakerLadder.ts";
import { clearsFeeHurdle, roundTripFeeRate } from "./fees.ts";
import { type SizingResult, sizePosition } from "./PositionSizer.ts";
import type { RungName } from "./rungs.ts";

export type Mode = "NORMAL" | "THRIFT" | "REDUCE_ONLY" | "PAUSED";

export interface AccountView {
  account: AccountId;
  equityUsd: number; // effective equity (paper: broker equity minus modeled costs)
  availableCashUsd: number; // settled / non-marginable cash available for new entries
  rung: RungName;
  band: Band;
  breakerMultiplier: number;
  autonomyStop: number;
  mode: Mode;
  killed: boolean;
  reconciledAt: number | null;
  ordersToday: number;
  heldOrPendingSymbols: string[];
  openSlots: number; // positions + pending entries + reservations
  heatUsedUsd: number; // risk of positions + pending entries + reservations
}

export interface MarketView {
  bid: number;
  ask: number;
  quoteAt: number;
  /** Audit W3-06: p90 of recent spreads; costs use max(now, typical) so a calm moment can't understate them. */
  typicalSpreadFrac?: number | null;
}

export interface AssetView {
  tradable: boolean;
  fractionable: boolean;
  minQty: number;
  qtyIncrement: number;
  minNotionalUsd: number;
}

export interface ValidateInput {
  contract: DecisionContract;
  account: AccountView;
  market: MarketView;
  asset: AssetView;
  reputationWeight: number;
  regimeMultiplier?: number;
  now: number;
}

export type ValidationResult =
  | { ok: true; entryPrice: number; sizing: Extract<SizingResult, { ok: true }>; feeRt: number }
  | { ok: false; reasons: string[] };

/**
 * The single gate every entry passes (constitution U1–U3, U6). Pure: same inputs, same answer.
 * Exits never go through here; exits are always allowed.
 */
export function validateEntry(i: ValidateInput, d: Doctrine, c: Constitution): ValidationResult {
  const r: string[] = [];
  const { contract: k, account: a, market: m } = i;

  // --- account state (fail closed) ---
  if (a.killed) r.push("account is KILLED");
  if (a.mode === "REDUCE_ONLY" || a.mode === "PAUSED") r.push(`account mode ${a.mode}`);
  if (a.band === "RED" || a.breakerMultiplier <= 0) r.push(`breaker ${a.band} forbids entries`);
  if (a.reconciledAt === null || i.now - a.reconciledAt > c.hard_limits.max_reconcile_age_seconds * 1000) {
    r.push("broker state not reconciled recently");
  }
  if (a.ordersToday >= c.hard_limits.max_orders_per_day_per_account) r.push("daily order cap reached");

  // --- contract and permissions ---
  r.push(...contractViolations(k));
  const arenas = a.account === "LIVE" ? c.allowed.live_arenas : c.allowed.paper_arenas;
  if (!arenas.includes(k.arena)) r.push(`${k.arena} not allowed on ${a.account}`);
  const strategy = d.strategies.find((s) => s.id === k.strategy_id);
  if (!strategy) r.push(`unknown strategy ${k.strategy_id}`);
  else {
    if (strategy.status !== "ACTIVE") r.push(`strategy ${k.strategy_id} is ${strategy.status}`);
    if (!strategy.accounts.includes(a.account)) r.push(`strategy not enabled for ${a.account}`);
  }

  // --- asset and market ---
  if (!i.asset.tradable) r.push("asset not tradable");
  if (k.arena === "EQUITIES" && !i.asset.fractionable) r.push("asset not fractionable");
  if (a.heldOrPendingSymbols.includes(k.symbol)) r.push("symbol already held or pending");
  const staleMs = Math.min(d.staleness.quote_seconds, c.hard_limits.max_quote_staleness_seconds) * 1000;
  if (i.now - m.quoteAt > staleMs) r.push("quote is stale");
  if (!(m.bid > 0 && m.ask >= m.bid)) r.push("invalid quote");
  const mid = (m.bid + m.ask) / 2;
  const spreadFrac = mid > 0 ? (m.ask - m.bid) / mid : 1;
  const maxSpread = (d.execution.max_spread_bps[k.arena] ?? 0) / 10_000;
  if (spreadFrac > maxSpread) r.push(`spread ${(spreadFrac * 10_000).toFixed(1)} bps > max`);
  const costSpread = Math.max(spreadFrac, m.typicalSpreadFrac ?? 0);

  const low = Number(k.entry_plan.zone_low);
  const high = Number(k.entry_plan.zone_high);
  const entryPrice = m.bid; // passive limit at the bid (doctrine.execution.order_style)
  if (entryPrice > high) r.push("price ran past the entry zone");
  if (entryPrice < low) r.push("price fell below the entry zone");

  // --- portfolio limits ---
  const rung = d.rungs[a.rung];
  if (a.openSlots >= rung.max_positions) r.push(`max positions (${rung.max_positions}) reached`);
  const heatBudget = a.equityUsd * rung.total_heat;
  const heatRoomUsd = heatBudget - a.heatUsedUsd;
  if (heatRoomUsd <= 0) r.push("portfolio heat budget exhausted");

  if (r.length > 0) return { ok: false, reasons: r };

  // --- fee hurdle ---
  const stop = Number(k.invalidation_criteria.stop_price);
  const target = Number(k.entry_plan.targets[0]);
  const provisionalNotional = a.equityUsd * rung.max_position_notional;
  const feeRt = roundTripFeeRate(k.arena, provisionalNotional, d);
  const hurdle = clearsFeeHurdle((target - entryPrice) / entryPrice, feeRt, costSpread, d);
  if (!hurdle.ok) {
    return {
      ok: false,
      reasons: [`expected move below fee hurdle (${(hurdle.required * 100).toFixed(2)}%)`],
    };
  }

  // --- size (U2) ---
  const sizing = sizePosition(
    {
      equityUsd: a.equityUsd,
      rung,
      conviction: k.proposed_conviction,
      pWin: k.win_prob_used,
      bearLethality: k.bear_lethality,
      reputationWeight: i.reputationWeight,
      regimeMultiplier: i.regimeMultiplier ?? 1,
      breakerMultiplier: a.breakerMultiplier,
      entry: entryPrice,
      stop,
      atr: k.atr,
      feeRt,
      spreadFrac: costSpread,
      availableCashUsd: a.availableCashUsd,
      heatRoomUsd,
      minNotionalUsd: Math.max(1, i.asset.minNotionalUsd),
      minQty: i.asset.minQty,
      qtyIncrement: i.asset.qtyIncrement,
    },
    d,
  );
  if (!sizing.ok) return { ok: false, reasons: sizing.reasons };

  // Belt and braces: constitution caps re-checked on the final numbers.
  const h = c.hard_limits;
  if (sizing.riskUsd > a.equityUsd * h.max_per_trade_risk_pct + 1e-9)
    return { ok: false, reasons: ["U3 per-trade risk"] };
  if (sizing.notionalUsd > a.equityUsd * h.max_position_notional_pct + 1e-9) {
    return { ok: false, reasons: ["U3 position notional"] };
  }
  if (a.heatUsedUsd + sizing.riskUsd > a.equityUsd * h.max_total_heat_pct + 1e-9) {
    return { ok: false, reasons: ["U3 total heat"] };
  }
  return { ok: true, entryPrice, sizing, feeRt };
}
