/**
 * Hindsight masking for historical court runs (audit AGT-03, ADR-103). Court models remember the past: shown the
 * real symbol and date of a famous crash, they decide differently than on the same numbers unlabelled. Any replay,
 * backtest or demo that puts a historical moment in front of the court must mask it first: the symbol becomes a
 * neutral name, every date moves by a fixed offset, years disappear from text, and the named entities the caller
 * lists (exchanges, coins, companies, people) become "[entity]". Live trading never needs this: its future is unknown.
 * Results of a masked run are still simulations and are never evidence of skill.
 */

export interface MaskOptions {
  symbol: string;
  /** what the symbol becomes, e.g. "ASSET-X/USD" */
  alias?: string;
  /** shift every ISO date and epoch time by this many days (default ~2.7 years) */
  shiftDays?: number;
  /** names to hide, matched as whole words, case-insensitive */
  entities?: string[];
}

const ISO = /\b(19|20)\d{2}-\d{2}-\d{2}(?:[T ][0-9:.]+Z?)?\b/g;
const YEAR = /\b(19[89]\d|20\d{2})\b/g;
const MONTH_DAY =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? \d{1,2}(?:st|nd|rd|th)?\b/g;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mask a JSON-serialisable value deeply. Pure. */
export function maskHistorical<T>(value: T, o: MaskOptions): T {
  const shift = (o.shiftDays ?? 1_000) * 86_400_000;
  const alias = o.alias ?? "ASSET-X/USD";
  const base = o.symbol.split("/")[0] ?? o.symbol;
  const names = [...new Set([o.symbol, base, ...(o.entities ?? [])])]
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  const ent = names.length ? new RegExp(`(?<![\\w/])(${names.map(esc).join("|")})(?![\\w])`, "gi") : null;
  const text = (s: string): string => {
    // shifted ISO dates are set aside first, so the year rule below doesn't eat them
    const kept: string[] = [];
    let t = s.replace(ISO, (m) => {
      const d = Date.parse(m.length === 10 ? `${m}T00:00:00Z` : m);
      const out = Number.isFinite(d) ? new Date(d + shift).toISOString() : "[date]";
      kept.push(m.length === 10 ? out.slice(0, 10) : out);
      return `⟦${kept.length - 1}⟧`;
    });
    t = t.replace(MONTH_DAY, "[date]").replace(YEAR, "[year]");
    t = t.replace(/⟦(\d+)⟧/g, (_, i) => kept[Number(i)] ?? "[date]");
    if (ent)
      t = t.replace(ent, (m) =>
        m.toUpperCase() === o.symbol.toUpperCase()
          ? alias
          : m.toUpperCase() === base.toUpperCase()
            ? (alias.split("/")[0] ?? alias)
            : "[entity]",
      );
    return t;
  };
  const walk = (v: unknown, key = ""): unknown => {
    if (typeof v === "string") return text(v);
    // epoch milliseconds in fields named like times move with the dates
    if (
      typeof v === "number" &&
      /(^|_)(t|ts|at|time|now|created|published|date)(_|$)|At$/i.test(key) &&
      v > 1e12 &&
      v < 1e13
    )
      return v + shift;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]),
      );
    return v;
  };
  return walk(value) as T;
}
