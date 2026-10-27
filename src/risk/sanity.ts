/**
 * Market sanity vetoes (ADR-067; dossier MLP0-005, MLP0-021). Pure parsers and checks; the brain fetches.
 *
 * - Stablecoin depeg: every crypto pair here is quoted in USD, but the venue settles in stablecoins; when USDT or
 *   USDC trades more than `max_depeg_bps` from $1, prices are not what they seem → no new crypto entries.
 * - Venue disagreement: Alpaca's mid vs Coinbase's public ticker. More than `max_venue_gap_pct` apart means one feed is
 *   wrong (a bad print, a stalled book) → no entry on that symbol.
 * - Exchange halts: Nasdaq's public trade-halt feed (covers NYSE/AMEX listings too). A halted stock's stop is
 *   meaningless → no entry until it resumes.
 * A source we can't reach is counted (policy vacuum) but doesn't freeze trading: these are extra checks on top of the
 * validator's own quote, spread and staleness gates, which still fail closed.
 */

export function depegBps(mid: number | null | undefined): number | null {
  return mid && mid > 0 ? Math.round(Math.abs(mid - 1) * 10_000) : null;
}

export function venueGapPct(alpacaMid: number, otherMid: number | null): number | null {
  if (!otherMid || !(otherMid > 0) || !(alpacaMid > 0)) return null;
  return Math.round((Math.abs(alpacaMid - otherMid) / otherMid) * 10_000) / 100;
}

/** Coinbase product id for an Alpaca crypto symbol ("BTC/USD" → "BTC-USD"). */
export const coinbaseProduct = (symbol: string) => symbol.replace("/", "-");

/** Symbols halted right now: items with no resumption trade time yet. */
export function haltedSymbols(rss: string): Set<string> {
  const out = new Set<string>();
  for (const m of rss.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1] ?? "";
    const sym = /<ndaq:IssueSymbol>([^<]+)<\/ndaq:IssueSymbol>/.exec(item)?.[1]?.trim();
    const resumed = /<ndaq:ResumptionTradeTime>\s*[^<\s][^<]*<\/ndaq:ResumptionTradeTime>/.test(item);
    if (sym && !resumed) out.add(sym.toUpperCase());
  }
  return out;
}
