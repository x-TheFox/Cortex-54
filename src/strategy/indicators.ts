/** Pure technical indicators over daily bars. Oldest first. */
export interface Bar {
  t: number; // bar start, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Wilder ATR. Returns null when there are not enough bars. */
export function atr(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i] as Bar;
    const prev = bars[i - 1] as Bar;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)));
  }
  let value = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + (tr[i] as number)) / period;
  return value;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < values.length; i++) e = (values[i] as number) * k + e * (1 - k);
  return e;
}

/** Highest high of the `lookback` bars before the last one (Donchian upper, excluding the current bar). */
export function priorHigh(bars: Bar[], lookback: number): number | null {
  if (bars.length < lookback + 1) return null;
  return Math.max(...bars.slice(-lookback - 1, -1).map((b) => b.h));
}
