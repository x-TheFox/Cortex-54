const DAY = 86_400_000;

/**
 * Milliseconds between `from` and `to` that fall on a weekday (Mon–Fri, UTC). Equity batches only run on weekdays,
 * so their age is measured this way; otherwise every weekend looks like an outage.
 */
export function weekdayMsBetween(from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  let t = from;
  while (t < to) {
    const dayEnd = (Math.floor(t / DAY) + 1) * DAY;
    const end = Math.min(dayEnd, to);
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) total += end - t;
    t = end;
  }
  return total;
}
