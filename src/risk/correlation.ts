import type { Bar } from "../strategy/indicators.ts";

/**
 * Correlation guard (doctrine sizing.correlation_guard, RISK_DOCTRINE "max 3 concurrent uncorrelated
 * positions"). Pearson correlation of daily log returns, aligned by UTC date. Pure.
 */

export const MIN_OVERLAP = 20;

function returnsByDay(bars: Bar[], since: number): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as Bar;
    const cur = sorted[i] as Bar;
    if (cur.t < since || !(prev.c > 0) || !(cur.c > 0)) continue;
    out.set(new Date(cur.t).toISOString().slice(0, 10), Math.log(cur.c / prev.c));
  }
  return out;
}

/** Correlation of two bar series over the window, or null when they share fewer than MIN_OVERLAP days. */
export function correlation(a: Bar[], b: Bar[], since: number): number | null {
  const ra = returnsByDay(a, since);
  const rb = returnsByDay(b, since);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [d, x] of ra) {
    const y = rb.get(d);
    if (y !== undefined) {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n < MIN_OVERLAP) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** The first held symbol whose correlation with the candidate exceeds `maxCorr`, if any. */
export function correlationVeto(
  candidate: Bar[],
  held: Record<string, Bar[]>,
  maxCorr: number,
  since: number,
): { symbol: string; corr: number } | null {
  for (const [symbol, bars] of Object.entries(held)) {
    const c = correlation(candidate, bars, since);
    if (c !== null && c > maxCorr) return { symbol, corr: Number(c.toFixed(3)) };
  }
  return null;
}
