import type { Doctrine } from "../contracts/doctrine.ts";

export type Band = "GREEN" | "YELLOW" | "ORANGE" | "RED";

export interface BreakerInput {
  equityCents: number;
  hwmCents: number;
  dayStartEquityCents: number;
  stopouts24h: number;
  locked: boolean; // RED is sticky until the operator unlocks with a postmortem (U5)
}

export interface BreakerState {
  band: Band;
  multiplier: number;
  drawdown: number;
  dailyLoss: number;
  reasons: string[];
}

/** Pure drawdown state machine (docs/RISK_DOCTRINE.md §4). */
export function evaluateBreaker(i: BreakerInput, d: Doctrine): BreakerState {
  const b = d.breakers;
  const drawdown = i.hwmCents > 0 ? Math.max(0, (i.hwmCents - i.equityCents) / i.hwmCents) : 0;
  const dailyLoss =
    i.dayStartEquityCents > 0
      ? Math.max(0, (i.dayStartEquityCents - i.equityCents) / i.dayStartEquityCents)
      : 0;

  const reasons: string[] = [];
  if (i.locked) reasons.push("locked after RED; operator postmortem required");
  if (drawdown >= b.red_drawdown) reasons.push(`drawdown ${(drawdown * 100).toFixed(2)}% ≥ red`);
  if (dailyLoss >= b.red_daily_loss) reasons.push(`daily loss ${(dailyLoss * 100).toFixed(2)}% ≥ red`);
  if (i.stopouts24h >= b.red_consecutive_stopouts_24h) reasons.push(`${i.stopouts24h} stop-outs in 24h`);

  // Fail closed (U6): a non-positive high-water mark or equity is corrupt data, not a 0% drawdown. ORANGE blocks
  // entries without the flatten-and-lock of RED (audit 2026-10-24: this used to read as GREEN).
  const corrupt = !(i.hwmCents > 0) || !(i.equityCents > 0);
  let band: Band;
  if (reasons.length > 0) band = "RED";
  else if (corrupt) band = "ORANGE";
  else if (drawdown >= b.orange_drawdown) band = "ORANGE";
  else if (drawdown >= b.yellow_drawdown) band = "YELLOW";
  else band = "GREEN";

  return { band, multiplier: b.multipliers[band], drawdown, dailyLoss, reasons };
}

const ORDER: Record<Band, number> = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 };

/**
 * Audit W3-01: hysteresis. A worse band applies at once; a better band only after the drawdown has sat below the
 * better band's threshold minus `recovery_margin` for `recovery_pulses` evaluations in a row, so a band can't flicker
 * on every tick around a boundary. RED (and the lock) keep their own rules. Pure: the caller stores `streak`.
 */
export function withHysteresis(
  prev: Band,
  next: BreakerState,
  streak: number,
  d: Doctrine,
): { state: BreakerState; streak: number } {
  if (ORDER[next.band] >= ORDER[prev] || prev === "RED") return { state: next, streak: 0 };
  const b = d.breakers;
  const margin = b.recovery_margin;
  // threshold the drawdown must clear to enter the better band
  const gate = next.band === "GREEN" ? b.yellow_drawdown : b.orange_drawdown;
  const clear = next.drawdown <= gate - margin;
  const n = clear ? streak + 1 : 0;
  if (n >= b.recovery_pulses) return { state: next, streak: 0 };
  return {
    state: {
      ...next,
      band: prev,
      multiplier: b.multipliers[prev],
      reasons: [...next.reasons, `recovering to ${next.band} (${n}/${b.recovery_pulses})`],
    },
    streak: n,
  };
}
