import type { Bar } from "../strategy/indicators.ts";

/**
 * Weekly book review (ADR-061; dossier MLP4-005, MLP4-032, MLP1-022 light). The whole book at once: what each position
 * is doing in R, how old it is against its horizon, how the positions move together, the book's beta to BTC and SPY,
 * and a crash replay: the worst 5-day drop each holding has had in the past year, applied to today's notional.
 * Measurement only; nothing here trades. Pure.
 */

export function dailyReturns(bars: Bar[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1] as Bar;
    const b = bars[i] as Bar;
    if (a.c > 0) m.set(Math.floor(b.t / 86_400_000), b.c / a.c - 1);
  }
  return m;
}

/** OLS beta of x on y over shared days; null with fewer than 20 shared days. */
export function beta(x: Bar[], y: Bar[]): number | null {
  const rx = dailyReturns(x);
  const ry = dailyReturns(y);
  const days = [...rx.keys()].filter((d) => ry.has(d));
  if (days.length < 20) return null;
  const xs = days.map((d) => rx.get(d) as number);
  const ys = days.map((d) => ry.get(d) as number);
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let cov = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    vy += ((ys[i] as number) - my) ** 2;
  }
  return vy > 0 ? Math.round((cov / vy) * 100) / 100 : null;
}

/** Worst close-to-close return over any `window` consecutive bars (≤ 0), or null. */
export function worstWindow(bars: Bar[], window = 5): number | null {
  if (bars.length <= window) return null;
  let worst = 0;
  for (let i = window; i < bars.length; i++) {
    const a = (bars[i - window] as Bar).c;
    const b = (bars[i] as Bar).c;
    if (a > 0) worst = Math.min(worst, b / a - 1);
  }
  return Math.round(worst * 10_000) / 10_000;
}

export interface BookLine {
  symbol: string;
  arena: string;
  notionalUsd: number;
  r: number;
  horizonFraction: number;
  stagnant: boolean;
  betaBtc: number | null;
  betaSpy: number | null;
  worst5d: number | null;
}

export interface BookSummary {
  lines: BookLine[];
  equityUsd: number;
  grossUsd: number;
  arenaShare: Record<string, number>;
  netBetaBtcUsd: number | null;
  netBetaSpyUsd: number | null;
  /** dollars lost if every holding repeated its worst 5-day drop at once (a crash replay, not a forecast) */
  stressLossUsd: number | null;
  maxPairCorr: { a: string; b: string; corr: number } | null;
}

export function summarizeBook(
  lines: BookLine[],
  equityUsd: number,
  pairCorr: { a: string; b: string; corr: number }[],
): BookSummary {
  const gross = lines.reduce((s, l) => s + l.notionalUsd, 0);
  const share: Record<string, number> = {};
  for (const l of lines) share[l.arena] = (share[l.arena] ?? 0) + l.notionalUsd / Math.max(gross, 1e-9);
  const sum = (f: (l: BookLine) => number | null) =>
    lines.every((l) => f(l) !== null) && lines.length
      ? Math.round(lines.reduce((s, l) => s + (f(l) as number) * l.notionalUsd, 0) * 100) / 100
      : null;
  const best = [...pairCorr].sort((a, b) => b.corr - a.corr)[0] ?? null;
  return {
    lines,
    equityUsd,
    grossUsd: Math.round(gross * 100) / 100,
    arenaShare: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    netBetaBtcUsd: sum((l) => l.betaBtc),
    netBetaSpyUsd: sum((l) => l.betaSpy),
    stressLossUsd: sum((l) => l.worst5d),
    maxPairCorr: best,
  };
}
