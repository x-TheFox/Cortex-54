import type { Doctrine } from "../contracts/doctrine.ts";
import { clamp, floorToIncrement } from "../lib/num.ts";
import type { Rung } from "./rungs.ts";

/**
 * Deterministic position sizer (constitution U2: models never size). Pure; no I/O, no clock.
 * Formula and worked example: docs/RISK_DOCTRINE.md §1.
 */
export interface SizingInput {
  equityUsd: number;
  rung: Rung;
  conviction: number; // 1..10
  pWin: number; // calibrated probability or strategy prior
  bearLethality: number; // 0..1
  reputationWeight: number; // W_rep
  breakerMultiplier: number; // M_breaker
  entry: number;
  stop: number;
  atr: number;
  feeRt: number; // round-trip fee fraction
  spreadFrac: number; // (ask - bid) / mid
  availableCashUsd: number;
  heatRoomUsd: number; // rung heat budget minus heat already used (positions + orders + reservations)
  minNotionalUsd: number;
  minQty: number;
  qtyIncrement: number;
}

export type SizingResult =
  | {
      ok: true;
      qty: string;
      notionalUsd: number;
      riskUsd: number;
      rEff: number;
      dStop: number;
      binding: "risk" | "concentration" | "cash" | "heat";
    }
  | { ok: false; reasons: string[] };

export function edgeGate(p: number, d: Doctrine): number {
  const { p_zero, p_full } = d.sizing.edge_gate;
  return clamp((p - p_zero) / (p_full - p_zero), 0, 1);
}

export function bearPenalty(lethality: number, d: Doctrine): number {
  const { floor, max_penalty } = d.sizing.bear_disagreement;
  return Math.min(max_penalty, Math.max(0, lethality - floor));
}

export function sizePosition(i: SizingInput, d: Doctrine): SizingResult {
  const reasons: string[] = [];
  if (!(i.entry > 0) || !(i.stop > 0) || !(i.atr > 0)) reasons.push("entry, stop and ATR must be positive");
  if (!(i.stop < i.entry)) reasons.push("stop must be below entry (long-only)");
  if (!(i.conviction >= 1 && i.conviction <= 10)) reasons.push("conviction must be 1..10");
  if (i.entry - i.stop < d.sizing.min_stop_atr_multiple * i.atr) {
    reasons.push(`stop closer than ${d.sizing.min_stop_atr_multiple}×ATR`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const wRep = clamp(i.reputationWeight, d.sizing.reputation_weight.min, d.sizing.reputation_weight.max);
  // Capped at the rung: reputation > 1 can lift a trade toward the cap, never past it.
  const rEff = Math.min(
    i.rung.per_trade_risk,
    i.rung.per_trade_risk *
      (i.conviction / 10) *
      (1 - bearPenalty(i.bearLethality, d)) *
      wRep *
      i.breakerMultiplier *
      edgeGate(i.pWin, d),
  );
  if (!(rEff > 0)) return { ok: false, reasons: ["effective risk is zero (no edge, breaker, or bear veto)"] };

  const dStop = (i.entry - i.stop) / i.entry + i.feeRt + i.spreadFrac / 2;
  const caps = {
    risk: (i.equityUsd * rEff) / dStop,
    concentration: i.equityUsd * i.rung.max_position_notional,
    cash: i.availableCashUsd,
    heat: Math.max(0, i.heatRoomUsd) / dStop,
  } as const;
  let binding: keyof typeof caps = "risk";
  for (const k of Object.keys(caps) as (keyof typeof caps)[]) if (caps[k] < caps[binding]) binding = k;
  const targetNotional = caps[binding];

  const qty = floorToIncrement(targetNotional / i.entry, i.qtyIncrement);
  const qtyNum = Number(qty);
  const notionalUsd = qtyNum * i.entry;
  if (qtyNum <= 0 || qtyNum < i.minQty) {
    return { ok: false, reasons: [`size below minimum quantity (binding: ${binding})`] };
  }
  if (notionalUsd < i.minNotionalUsd) {
    return {
      ok: false,
      reasons: [`notional $${notionalUsd.toFixed(2)} below minimum (binding: ${binding})`],
    };
  }
  return { ok: true, qty, notionalUsd, riskUsd: notionalUsd * dStop, rEff, dStop, binding };
}
