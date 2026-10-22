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

  let band: Band;
  if (reasons.length > 0) band = "RED";
  else if (drawdown >= b.orange_drawdown) band = "ORANGE";
  else if (drawdown >= b.yellow_drawdown) band = "YELLOW";
  else band = "GREEN";

  return { band, multiplier: b.multipliers[band], drawdown, dailyLoss, reasons };
}
