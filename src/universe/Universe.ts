import type { Constitution } from "../contracts/constitution.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import { one, type SqlLike } from "../cortex/store.ts";
import { normalizeSymbol, type ScreenResult, type UniverseArena } from "./screen.ts";

/**
 * Dynamic universe state (ADR-058), in the DO hot schema (`universe`, `headline_ring`). Rows:
 * - TRADE: passed the screen; may be traded like a watchlist symbol until `expires_at` (kept while held).
 * - WATCH: named by research as related; its news always reaches Tier 1, and the screen runs if it ever gets there.
 * - REJECTED: failed the screen; cached for a day so the same symbol isn't re-screened every headline.
 * The doctrine watchlists are the permanent core and never live in this table.
 */

export type UniverseStatus = "TRADE" | "WATCH" | "REJECTED";

export type UniverseRow = {
  symbol: string;
  arena: UniverseArena;
  status: UniverseStatus;
  source: string;
  reason: string;
  metrics_json: string;
  added_at: number;
  expires_at: number;
};

const DAY = 86_400_000;

export function coreSymbols(d: Doctrine): Map<string, UniverseArena> {
  const m = new Map<string, UniverseArena>();
  for (const s of d.watchlists.crypto ?? []) m.set(s, "CRYPTO");
  for (const k of ["crypto_proxies", "equities_core", "equities_catalyst"])
    for (const s of d.watchlists[k] ?? []) m.set(s, "EQUITIES");
  return m;
}

export class Universe {
  constructor(
    private readonly sql: SqlLike,
    private readonly d: Doctrine,
    readonly c: Constitution,
  ) {}

  get enabled(): boolean {
    return this.d.universe.enabled;
  }

  row(symbol: string): UniverseRow | null {
    return one<UniverseRow>(this.sql, "SELECT * FROM universe WHERE symbol = ?", symbol);
  }

  /** Live TRADE rows (symbol → arena). Expired rows count while a position is still open on them. */
  tradeable(now: number): Map<string, UniverseArena> {
    if (!this.enabled) return new Map();
    const rows = this.sql.exec<{ symbol: string; arena: UniverseArena }>(
      `SELECT symbol, arena FROM universe WHERE status = 'TRADE'
         AND (expires_at > ? OR symbol IN (SELECT symbol FROM positions))`,
      now,
    );
    return new Map(rows.map((r) => [r.symbol, r.arena]));
  }

  watched(now: number): string[] {
    if (!this.enabled) return [];
    return this.sql
      .exec<{ symbol: string }>(
        "SELECT symbol FROM universe WHERE status IN ('TRADE','WATCH') AND expires_at > ?",
        now,
      )
      .map((r) => r.symbol);
  }

  /** Core first, then the dynamic TRADE rows. Crypto "BTCUSD" style symbols are normalised. */
  resolve(symbols: string[], now: number): { symbol: string; arena: UniverseArena; dynamic: boolean } | null {
    const core = coreSymbols(this.d);
    const dyn = this.tradeable(now);
    for (const raw of symbols) {
      const n = normalizeSymbol(raw);
      const s = n?.symbol ?? raw.toUpperCase();
      const c = core.get(s);
      if (c) return { symbol: s, arena: c, dynamic: false };
      const a = dyn.get(s);
      if (a) return { symbol: s, arena: a, dynamic: true };
    }
    return null;
  }

  isDynamic(symbol: string, now: number): boolean {
    return !coreSymbols(this.d).has(symbol) && this.tradeable(now).has(symbol);
  }

  /** A screened symbol: TRADE (passed) or REJECTED (cached for a day). Evicts the oldest unheld TRADE row at the cap. */
  record(
    symbol: string,
    arena: UniverseArena,
    res: ScreenResult,
    source: string,
    why: string,
    now: number,
  ): void {
    if (res.ok) {
      const n =
        one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM universe WHERE status = 'TRADE'")?.n ?? 0;
      if (n >= this.d.universe.max_dynamic)
        this.sql.exec(
          `DELETE FROM universe WHERE symbol = (SELECT symbol FROM universe WHERE status = 'TRADE'
             AND symbol NOT IN (SELECT symbol FROM positions) ORDER BY expires_at LIMIT 1)`,
        );
    }
    this.sql.exec(
      `INSERT INTO universe (symbol, arena, status, source, reason, metrics_json, added_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET arena = excluded.arena, status = excluded.status, source = excluded.source,
         reason = excluded.reason, metrics_json = excluded.metrics_json, expires_at = excluded.expires_at`,
      symbol,
      arena,
      res.ok ? "TRADE" : "REJECTED",
      source.slice(0, 40),
      (res.ok ? why : res.reasons.join("; ")).slice(0, 300),
      JSON.stringify(res.metrics),
      now,
      now + (res.ok ? this.d.universe.ttl_days * DAY : DAY),
    );
  }

  /** Research-named related symbols: watched (news priority) without screening. Never downgrades a TRADE row. */
  watch(symbols: string[], source: string, now: number): string[] {
    if (!this.enabled) return [];
    const core = coreSymbols(this.d);
    const added: string[] = [];
    const cap = this.d.universe.max_watch;
    for (const raw of symbols) {
      const n = normalizeSymbol(raw);
      if (!n || core.has(n.symbol)) continue;
      const existing = this.row(n.symbol);
      if (existing && existing.status !== "WATCH" && existing.expires_at > now) continue;
      const count =
        one<{ n: number }>(
          this.sql,
          "SELECT COUNT(*) AS n FROM universe WHERE status = 'WATCH' AND expires_at > ?",
          now,
        )?.n ?? 0;
      if (!existing && count >= cap) break;
      this.sql.exec(
        `INSERT INTO universe (symbol, arena, status, source, reason, metrics_json, added_at, expires_at)
         VALUES (?, ?, 'WATCH', ?, 'named by research', '{}', ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET status = 'WATCH', source = excluded.source, expires_at = excluded.expires_at`,
        n.symbol,
        n.arena,
        source.slice(0, 40),
        now,
        now + this.d.universe.ttl_days * DAY,
      );
      added.push(n.symbol);
    }
    return added;
  }

  /** A new catalyst on a dynamic symbol keeps it in the universe. */
  touch(symbol: string, now: number): void {
    this.sql.exec(
      "UPDATE universe SET expires_at = MAX(expires_at, ?) WHERE symbol = ? AND status = 'TRADE'",
      now + this.d.universe.ttl_days * DAY,
      symbol,
    );
  }

  compact(now: number): void {
    this.sql.exec(
      "DELETE FROM universe WHERE expires_at < ? AND symbol NOT IN (SELECT symbol FROM positions)",
      now,
    );
    this.sql.exec("DELETE FROM headline_ring WHERE at < ?", now - 6 * 3_600_000);
  }

  counts(now: number): { trade: number; watch: number; rejected: number } {
    const rows = this.sql.exec<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM universe WHERE expires_at > ? GROUP BY status",
      now,
    );
    const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { trade: get("TRADE"), watch: get("WATCH"), rejected: get("REJECTED") };
  }

  list(now: number): UniverseRow[] {
    return this.sql.exec<UniverseRow>(
      "SELECT * FROM universe WHERE expires_at > ? ORDER BY status, added_at DESC LIMIT 200",
      now,
    );
  }

  // ---- headline ring (near-duplicate memory for the prefilter) ----
  recentTokens(now: number): Set<string>[] {
    return this.sql
      .exec<{ tokens: string }>(
        "SELECT tokens FROM headline_ring WHERE at > ? ORDER BY at DESC LIMIT 300",
        now - 4 * 3_600_000,
      )
      .map((r) => new Set(r.tokens.split(" ").filter(Boolean)));
  }

  rememberHeadline(id: string, tokens: Set<string>, now: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO headline_ring (id, tokens, at) VALUES (?, ?, ?)",
      id,
      [...tokens].slice(0, 30).join(" "),
      now,
    );
  }
}
