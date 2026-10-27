import type { Bar } from "../strategy/indicators.ts";

/**
 * Lateness meter (ADR-060; dossier PSS-014 / MLP5-009 / MLP1-005 / MLP1-013). How much of a catalyst's move is
 * already done when we see it, measured in daily ATRs on hourly bars:
 *
 * - move_since_atr: price now vs the price when the headline came out. ≥ `late_atr` → LATE (chasing).
 * - pre_drift_atr: the 24 h *before* the headline. A large drift means it leaked or was priced in.
 * - volume_ratio: average hourly volume since the headline vs the 24 h before (is anyone actually trading it?).
 *
 * Code computes all of it; the court sees the numbers, and a LATE verdict stops the case at Tier 0 (refusal is graded,
 * so the Governor can show whether the meter costs or saves money). Pure.
 */

export interface Lateness {
  minutes_since: number;
  price_at_catalyst: number | null;
  move_since_pct: number | null;
  move_since_atr: number | null;
  pre_drift_atr: number | null;
  volume_ratio: number | null;
  verdict: "EARLY" | "MID" | "LATE" | "UNKNOWN";
}

const r = (x: number, n = 3) => Math.round(x * 10 ** n) / 10 ** n;

export function lateness(
  hourly: Bar[],
  catalystAt: number,
  bid: number,
  atrDaily: number,
  now: number,
  cfg: { late_atr: number; mid_atr: number },
): Lateness {
  const minutes = Math.max(0, Math.round((now - catalystAt) / 60_000));
  const unknown: Lateness = {
    minutes_since: minutes,
    price_at_catalyst: null,
    move_since_pct: null,
    move_since_atr: null,
    pre_drift_atr: null,
    volume_ratio: null,
    verdict: "UNKNOWN",
  };
  const bars = [...hourly].sort((a, b) => a.t - b.t);
  if (bars.length === 0 || !(atrDaily > 0) || !(bid > 0)) return unknown;
  // the bar that contains the headline: its open is the last price before the news could move it
  let at: Bar | undefined;
  for (const b of bars) if (b.t <= catalystAt) at = b;
  const base = at ? at.o : (bars[0]?.o ?? null);
  if (base === null || !(base > 0)) return unknown;
  const move = bid - base;
  const start = at?.t ?? catalystAt; // the headline's own hour counts as "after"
  const before = bars.filter((b) => b.t < start && b.t >= start - 24 * 3_600_000);
  const after = bars.filter((b) => b.t >= (at?.t ?? catalystAt));
  const first = before[0];
  const preDrift = first ? (base - first.o) / atrDaily : null;
  const avg = (xs: Bar[]) => (xs.length ? xs.reduce((s, b) => s + b.v, 0) / xs.length : null);
  const vb = avg(before);
  const va = avg(after);
  const moveAtr = move / atrDaily;
  return {
    minutes_since: minutes,
    price_at_catalyst: r(base, 6),
    move_since_pct: r(move / base, 4),
    move_since_atr: r(moveAtr, 2),
    pre_drift_atr: preDrift === null ? null : r(preDrift, 2),
    volume_ratio: vb && va !== null && vb > 0 ? r(va / vb, 2) : null,
    verdict: moveAtr >= cfg.late_atr ? "LATE" : moveAtr >= cfg.mid_atr ? "MID" : "EARLY",
  };
}

/** US equity session label for the temporal fact sheet (display only; trading uses the Alpaca clock). */
export function usSession(now: number): "PRE_MARKET" | "REGULAR" | "AFTER_HOURS" | "CLOSED" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (["Sat", "Sun"].includes(get("weekday"))) return "CLOSED";
  const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  if (mins >= 570 && mins < 960) return "REGULAR";
  if (mins >= 240 && mins < 570) return "PRE_MARKET";
  if (mins >= 960 && mins < 1200) return "AFTER_HOURS";
  return "CLOSED";
}
