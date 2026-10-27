/**
 * Tier 0.5 headline prefilter (ADR-058). With the whole Alpaca news stream as intake, Tier 1 (clef-flash) would see
 * hundreds of headlines a day it can't afford. This zero-neuron scorer keeps the ones that look like catalysts and
 * drops wire noise (law-firm "investor alerts", conference and webcast notices, dividend declarations, market wraps,
 * near-duplicates). Core, held and watched symbols always pass to Tier 1, which still makes the real call.
 * Pure. A trained model (MLP0-010) can replace `scoreHeadline` once `triage_log` has enough decisions.
 */

export interface PrefilterItem {
  headline: string;
  summary: string;
  symbols: string[];
  source: string;
}

export interface PrefilterContext {
  /** symbols that always pass (doctrine watchlists, held, dynamic universe, research-related watch list) */
  priority: Set<string>;
  /** token sets of recent headlines (near-duplicate check) */
  recent: Set<string>[];
  minScore: number;
}

export interface PrefilterVerdict {
  pass: boolean;
  score: number;
  why: string;
  tokens: Set<string>;
}

const NOISE: [RegExp, number][] = [
  [
    /\b(investor|shareholder)s? (alert|reminder|notice)\b|\bclass action\b|\blost money\b|\blaw firm\b|\bdeadline\b.*\blead plaintiff\b/i,
    -6,
  ],
  [
    /\b(rosen|pomerantz|levi & korsinsky|bragar|glancy|faruqi|kessler topaz|bronstein|schall|gross law|portnoy|robbins geller)\b/i,
    -6,
  ],
  [
    /\bto (present|participate|host)\b.*\b(conference|summit|webcast|fireside)\b|\bwebcast\b|\bconference call\b.*\b(schedule|date)\b/i,
    -4,
  ],
  [/\b(declares?|announces?) (quarterly |monthly |special )?(cash )?dividend\b|\bex-dividend\b/i, -3],
  [
    /\bstocks? (moving|to watch)\b|\bpremarket movers\b|\bmid-day movers\b|\btop (gainers|losers)\b|\bmarket (wrap|recap)\b/i,
    -3,
  ],
  [/\bunusual options activity\b|\boptions (activity|traders)\b|\bwhale\b/i, -2],
  [/\b(earnings|q[1-4]) preview\b|\bwhat to expect\b/i, -2],
  [/\bannounces? (date|timing) of\b|\bto report\b.*\bresults on\b/i, -3],
  [/\b(etf|fund) (daily|weekly) (report|update)\b|\bnet asset value\b/i, -3],
  [
    /\bperiodic report\b|\btransactions in week\b|\b(weekly|reports?) share buy-?back (transactions|activity|progress)\b|\bshare buy-?back (transactions|progress|activity)\b/i,
    -4,
  ],
  [/\b(appoints?|names?|joins?)\b.*\b(board|director|officer|cfo|ceo|svp|vp)\b/i, -1],
];

const SIGNAL: [RegExp, number][] = [
  [/\b(acquire[sd]?|acquisition|merger|to buy|buyout|takeover|tender offer)\b/i, 3],
  [/\bfda (approv|clear|grant)|\bapproval\b|\bphase (2|3|ii|iii)\b.*\b(met|success|positive)\b/i, 3],
  [/\b(raises?|boosts?|lifts?) (full-year |annual )?(guidance|outlook|forecast)\b/i, 3],
  [
    /\b(beats?|tops?|crush(es)?)\b.*\b(estimates?|expectations|consensus)\b|\brecord (revenue|quarter|sales)\b/i,
    2.5,
  ],
  [/\b(secures?|awarded|lands?|signs?|inks?)\b.*\b(contract|order|deal|agreement)s?\b/i, 1.5],
  [/\b(upgrade[sd]?|initiates? .* (buy|outperform|overweight))\b/i, 2],
  [
    /\b(contract|deal|partnership|agreement|collaboration|award|order)s?\b.*\b(billion|million)\b|\b(billion|million)\b.*\b(contract|deal|partnership|agreement|award|order)s?\b/i,
    2,
  ],
  [/\bwins?\b.*\b(contract|award|approval|order|case|lawsuit|bid)\b/i, 1.5],
  [/\b(buyback|repurchase)\b/i, 1.5],
  [/\b(launch(es|ed)?|unveil(s|ed)?|introduc(es|ed))\b/i, 1],
  [
    /\b(listing|lists?|to list)\b.*\b(exchange|coinbase|binance|robinhood|nasdaq)\b|\betf (approval|filing|inflows?)\b/i,
    2.5,
  ],
  [/\b(s&p 500|index) (inclusion|addition|to join)\b|\bjoins? the s&p\b/i, 3],
  [/\b(surges?|soars?|jumps?|spikes?|rall(y|ies))\b/i, 1],
  [/\b(sec|doj|ftc)\b.*\b(drops?|dismiss|settle)/i, 2],
];

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "with",
  "as",
  "at",
  "by",
  "is",
  "are",
  "its",
  "it",
  "from",
  "after",
  "says",
  "said",
  "will",
  "this",
  "that",
  "inc",
  "corp",
  "shares",
  "stock",
]);

export function headlineTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9$%. ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Token Jaccard ≥ 0.6, or one headline's tokens ≥ 85% inside the other's (syndicated rewrites). */
export function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union >= 0.6 || inter / Math.min(a.size, b.size) >= 0.85;
}

export function scoreHeadline(it: PrefilterItem): number {
  const text = `${it.headline} ${it.summary}`;
  let s = 0;
  for (const [re, w] of NOISE) if (re.test(text)) s += w;
  for (const [re, w] of SIGNAL) if (re.test(text)) s += w;
  if (it.symbols.length === 1) s += 1; // a story about one company is more specific than a roundup
  if (it.symbols.length > 5) s -= 2;
  if (it.summary.length > 80) s += 0.5;
  return s;
}

/** US tickers and crypto pairs Alpaca could trade; foreign listings ("9434", "KEMIRA") can't be ported. */
const TRADEABLE_SHAPE = /^(?:[A-Z]{1,5}(?:\.[A-Z])?|[A-Z0-9]{2,10}(?:\/)?USD)$/;

export function prefilter(it: PrefilterItem, ctx: PrefilterContext): PrefilterVerdict {
  const tokens = headlineTokens(it.headline);
  if (it.symbols.length === 0) return { pass: false, score: 0, why: "no symbols", tokens };
  if (!it.symbols.some((s) => TRADEABLE_SHAPE.test(s.toUpperCase())))
    return { pass: false, score: 0, why: "no US-tradeable symbol", tokens };
  const priority = it.symbols.some((s) => ctx.priority.has(s.toUpperCase()));
  const score = scoreHeadline(it);
  // core/held/watched symbols keep their pre-ADR-058 intake exactly (Tier 1 dedupes them by catalyst later)
  if (priority) return { pass: true, score, why: "core/held/watched symbol", tokens };
  if (ctx.recent.some((r) => nearDuplicate(tokens, r)))
    return { pass: false, score: 0, why: "near-duplicate of a recent headline", tokens };
  if (it.symbols.length > 8) return { pass: false, score, why: "market roundup (many symbols)", tokens };
  return score >= ctx.minScore
    ? { pass: true, score, why: "catalyst words", tokens }
    : { pass: false, score, why: "looks like wire noise", tokens };
}
