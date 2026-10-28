import type { SqlLike, SqlValue } from "../cortex/store.ts";
import { sha256Hex } from "../lib/sha256.ts";

/**
 * Hash-chained journal + D1 outbox (constitution U7).
 *
 * Every write is synchronous into the DO's own SQLite (no await → no interleaving → the chain can't fork),
 * then flushed to D1 in batches at the end of each pulse. If D1 is down or over quota, rows wait in the
 * outbox; nothing is lost and the chain head stays authoritative in the DO.
 */
export type JournalAccount = "PAPER" | "LIVE" | "SYSTEM";

export const GENESIS = "0".repeat(64);

export function rowHash(prev: string, seq: number, ts: number, kind: string, payloadJson: string): string {
  return sha256Hex(`${prev}|${seq}|${ts}|${kind}|${payloadJson}`);
}

/** D1 tables the outbox may write to (whitelist; table names are interpolated into SQL). */
// audit F-A3-01: a batch that lands in D1 but whose DELETE never runs (crash, eviction) is sent again. Tables with a
// natural key (journal seq + row hash, contract ids, fill ids) ignore the replay; the AUTOINCREMENT logs below have no
// natural key, so a replay there can add a duplicate log line (noise, never a broken chain or a double trade).
const TABLES = {
  journal: { ignoreDupes: true },
  decision_contracts: { ignoreDupes: true },
  orders_log: { ignoreDupes: false },
  fills: { ignoreDupes: true },
  rejections: { ignoreDupes: false },
  batch_results: { ignoreDupes: false },
  triage_log: { ignoreDupes: false },
  llm_calls: { ignoreDupes: false },
  // FK guard: a grade for an unknown rejection is skipped instead of failing (and jamming) the whole batch.
  rejection_grades: { ignoreDupes: true, requires: { col: "rejection_id", table: "rejections", ref: "id" } },
  postmortems: { ignoreDupes: false },
  source_reputation: { ignoreDupes: false, upsert: true },
  skill_fitness: { ignoreDupes: false, upsert: true },
  options_shadow: { ignoreDupes: true },
  beliefs: { ignoreDupes: false, upsert: true },
} as const;
export type OutboxTable = keyof typeof TABLES;

/** A bound statement, opaque to the journal. */
export type D1PreparedLike = unknown;

export interface D1Like {
  prepare(query: string): { bind(...values: unknown[]): D1PreparedLike };
  batch(statements: unknown[]): Promise<unknown[]>;
}

export class Journal {
  /** Optional observer (the brain's #agent-terminal stream). Never throws into append. */
  onAppend?: (row: {
    seq: number;
    ts: number;
    account: string;
    kind: string;
    refId: string | null;
    payloadJson: string;
    /** ADR-068: the row's hash and its predecessor's, so observers (the hub feed) can publish verifiable rows */
    rowSha256?: string;
    prevRowSha256?: string;
  }) => void;

  constructor(private readonly sql: SqlLike) {}

  /**
   * Audit W1-03: after a hot-storage reset the head is GENESIS while D1 still holds the chain, and every new row would
   * collide with an existing seq forever. On boot, adopt D1's head when (and only when) the hot head is empty and
   * nothing is waiting in the outbox. Returns what happened.
   */
  async reanchor(
    d1Head: () => Promise<{ seq: number; sha: string } | null>,
  ): Promise<"kept" | "adopted" | "fresh"> {
    if (this.head().seq !== 0) return "kept";
    const pending = this.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM d1_outbox WHERE tbl = 'journal'",
    )[0];
    if ((pending?.n ?? 0) > 0) return "kept";
    const h = await d1Head();
    if (!h || h.seq <= 0 || !/^[0-9a-f]{64}$/.test(h.sha)) return "fresh";
    this.sql.exec(
      "INSERT INTO journal_head (id, seq, row_sha256) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, row_sha256 = excluded.row_sha256",
      h.seq,
      h.sha,
    );
    return "adopted";
  }

  head(): { seq: number; sha: string } {
    const row = this.sql.exec<{ seq: number; row_sha256: string }>(
      "SELECT seq, row_sha256 FROM journal_head WHERE id = 1",
    )[0];
    return row ? { seq: row.seq, sha: row.row_sha256 } : { seq: 0, sha: GENESIS };
  }

  append(
    account: JournalAccount,
    kind: string,
    refId: string | null,
    payload: unknown,
    now: number,
  ): { seq: number; sha: string } {
    const prev = this.head();
    const seq = prev.seq + 1;
    const payloadJson = JSON.stringify(payload ?? {});
    const sha = rowHash(prev.sha, seq, now, kind, payloadJson);
    this.onAppend?.({
      seq,
      ts: now,
      account,
      kind,
      refId,
      payloadJson,
      rowSha256: sha,
      prevRowSha256: prev.sha,
    });
    this.sql.exec(
      "INSERT INTO journal_head (id, seq, row_sha256) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, row_sha256 = excluded.row_sha256",
      seq,
      sha,
    );
    this.enqueue(
      "journal",
      {
        seq,
        ts: now,
        account,
        kind,
        ref_id: refId,
        payload_json: payloadJson,
        prev_row_sha256: prev.sha,
        row_sha256: sha,
      },
      now,
    );
    return { seq, sha };
  }

  enqueue(table: OutboxTable, row: Record<string, SqlValue>, now: number): void {
    this.sql.exec(
      "INSERT INTO d1_outbox (tbl, row_json, created_at) VALUES (?, ?, ?)",
      table,
      JSON.stringify(row),
      now,
    );
  }

  pending(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM d1_outbox")[0]?.n ?? 0;
  }

  /**
   * Flush up to `max` outbox rows to D1. Returns rows written; throws when nothing could be written (D1 down: rows
   * kept, the caller alerts).
   *
   * Poison-pill quarantine (audit W1-01): one bad row used to fail the whole batch forever and silently stop the
   * audit trail. A row that cannot even be turned into a statement is quarantined at once. When a batch fails, it is
   * bisected (≤ 8 extra D1 calls) to find the failing rows; a failing row earns an attempt only when other rows in
   * the same flush succeeded (so an outage never quarantines good rows), and is moved to `d1_outbox_dead` after 3.
   * Quarantined journal rows leave a visible gap in the D1 chain, which the Governor's chain check reports — the
   * row itself stays in the hot dead table for replay.
   */
  /** Audit W1-06: D1 batches are awaits the DO input gate doesn't cover; two flushes must never send the same rows. */
  private flushing = false;

  async flush(db: D1Like, max = 40): Promise<number> {
    if (this.flushing) return 0; // another flush is in flight; its rows go out with it, the rest next pulse
    this.flushing = true;
    try {
      return await this.flushOnce(db, max);
    } finally {
      this.flushing = false;
    }
  }

  private async flushOnce(db: D1Like, max: number): Promise<number> {
    const rows = this.sql.exec<{ id: number; tbl: string; row_json: string; created_at: number }>(
      "SELECT id, tbl, row_json, created_at FROM d1_outbox ORDER BY id LIMIT ?",
      max,
    );
    if (rows.length === 0) return 0;
    const now = Date.now();
    const built: { id: number; stmt: D1PreparedLike }[] = [];
    for (const r of rows) {
      try {
        built.push({ id: r.id, stmt: this.statement(db, r.tbl, r.row_json) });
      } catch (e) {
        this.quarantine(r, String(e), now);
      }
    }
    let written = 0;
    let calls = 0;
    const failed: number[] = [];
    let lastError: unknown = null;
    const run = async (part: { id: number; stmt: D1PreparedLike }[]): Promise<void> => {
      if (part.length === 0) return;
      if (calls >= 9) {
        for (const x of part) failed.push(x.id);
        return;
      }
      calls++;
      try {
        await db.batch(part.map((x) => x.stmt));
        const ids = part.map((x) => x.id);
        this.sql.exec(`DELETE FROM d1_outbox WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids);
        written += part.length;
      } catch (e) {
        lastError = e;
        if (part.length === 1) {
          failed.push((part[0] as { id: number }).id);
          return;
        }
        const mid = Math.ceil(part.length / 2);
        await run(part.slice(0, mid));
        await run(part.slice(mid));
      }
    };
    await run(built);
    if (written > 0 && failed.length > 0) {
      for (const id of failed) {
        const key = `outbox_fail:${id}`;
        const n =
          Number(
            this.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)[0]?.value ?? 0,
          ) + 1;
        this.sql.exec(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          key,
          String(n),
          now,
        );
        const r = rows.find((x) => x.id === id);
        if (r && n >= 3) this.quarantine(r, String(lastError), now);
      }
    }
    if (written === 0 && failed.length > 0)
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    return written;
  }

  /**
   * Audit F-A3-02: the repair path. Quarantined rows go back into the outbox (a new id, so they flush after the
   * backlog); a row that is still bad earns its three strikes again and returns to quarantine. Run daily, so a
   * row that failed on a transient D1 schema/quota problem heals by itself.
   */
  requeueQuarantined(now: number, max = 200): number {
    const rows = this.sql.exec<{ id: number; tbl: string; row_json: string; created_at: number }>(
      "SELECT id, tbl, row_json, created_at FROM d1_outbox_dead ORDER BY id LIMIT ?",
      max,
    );
    for (const r of rows) {
      this.sql.exec(
        "INSERT INTO d1_outbox (tbl, row_json, created_at) VALUES (?, ?, ?)",
        r.tbl,
        r.row_json,
        r.created_at,
      );
      this.sql.exec("DELETE FROM d1_outbox_dead WHERE id = ?", r.id);
    }
    if (rows.length) this.append("SYSTEM", "OUTBOX_REQUEUE", null, { rows: rows.length }, now);
    return rows.length;
  }

  /** Rows moved aside by the poison-pill guard (for the status view and replay). */
  quarantined(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM d1_outbox_dead")[0]?.n ?? 0;
  }

  private quarantine(
    r: { id: number; tbl: string; row_json: string; created_at: number },
    error: string,
    now: number,
  ) {
    this.sql.exec(
      "INSERT OR REPLACE INTO d1_outbox_dead (id, tbl, row_json, created_at, error, dead_at) VALUES (?, ?, ?, ?, ?, ?)",
      r.id,
      r.tbl,
      r.row_json,
      r.created_at,
      error.slice(0, 500),
      now,
    );
    this.sql.exec("DELETE FROM d1_outbox WHERE id = ?", r.id);
    this.sql.exec("DELETE FROM settings WHERE key = ?", `outbox_fail:${r.id}`);
    this.append("SYSTEM", "OUTBOX_QUARANTINE", String(r.id), { tbl: r.tbl, error: error.slice(0, 300) }, now);
  }

  private statement(db: D1Like, tbl: string, rowJson: string): D1PreparedLike {
    const spec = TABLES[tbl as OutboxTable];
    if (!spec) throw new Error(`outbox: table ${tbl} not whitelisted`);
    const obj = JSON.parse(rowJson) as Record<string, SqlValue>;
    const cols = Object.keys(obj);
    for (const c of cols) if (!/^[a-z_0-9]+$/.test(c)) throw new Error(`outbox: bad column ${c}`);
    const verb =
      "upsert" in spec && spec.upsert
        ? "INSERT OR REPLACE"
        : spec.ignoreDupes
          ? "INSERT OR IGNORE"
          : "INSERT";
    const values = cols.map((c) => obj[c] ?? null);
    const marks = cols.map(() => "?").join(", ");
    if ("requires" in spec) {
      const q = spec.requires;
      const sql = `${verb} INTO ${tbl} (${cols.join(", ")}) SELECT ${marks} WHERE EXISTS (SELECT 1 FROM ${q.table} WHERE ${q.ref} = ?)`;
      return db.prepare(sql).bind(...values, obj[q.col] ?? null);
    }
    return db.prepare(`${verb} INTO ${tbl} (${cols.join(", ")}) VALUES (${marks})`).bind(...values);
  }
}

/** Verify a contiguous run of journal rows (used by tests and the weekly Governor). */
export function verifyChain(
  rows: {
    seq: number;
    ts: number;
    kind: string;
    payload_json: string;
    prev_row_sha256: string;
    row_sha256: string;
  }[],
): { ok: boolean; brokenAt: number | null } {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) break;
    if (i > 0 && r.prev_row_sha256 !== rows[i - 1]?.row_sha256) return { ok: false, brokenAt: r.seq };
    if (rowHash(r.prev_row_sha256, r.seq, r.ts, r.kind, r.payload_json) !== r.row_sha256) {
      return { ok: false, brokenAt: r.seq };
    }
  }
  return { ok: true, brokenAt: null };
}
