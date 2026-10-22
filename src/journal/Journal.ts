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
const TABLES = {
  journal: { ignoreDupes: false },
  decision_contracts: { ignoreDupes: true },
  orders_log: { ignoreDupes: false },
  fills: { ignoreDupes: true },
  rejections: { ignoreDupes: false },
} as const;
export type OutboxTable = keyof typeof TABLES;

export interface D1Like {
  prepare(query: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown[]>;
}

export class Journal {
  constructor(private readonly sql: SqlLike) {}

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

  /** Flush up to `max` outbox rows to D1 in one batch. Returns rows written. Throws on D1 failure (rows kept). */
  async flush(db: D1Like, max = 40): Promise<number> {
    const rows = this.sql.exec<{ id: number; tbl: string; row_json: string }>(
      "SELECT id, tbl, row_json FROM d1_outbox ORDER BY id LIMIT ?",
      max,
    );
    if (rows.length === 0) return 0;
    const statements = rows.map((r) => {
      const spec = TABLES[r.tbl as OutboxTable];
      if (!spec) throw new Error(`outbox: table ${r.tbl} not whitelisted`);
      const obj = JSON.parse(r.row_json) as Record<string, SqlValue>;
      const cols = Object.keys(obj);
      for (const c of cols) if (!/^[a-z_0-9]+$/.test(c)) throw new Error(`outbox: bad column ${c}`);
      const sql = `INSERT ${spec.ignoreDupes ? "OR IGNORE " : ""}INTO ${r.tbl} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      return db.prepare(sql).bind(...cols.map((c) => obj[c] ?? null));
    });
    await db.batch(statements);
    const last = rows.at(-1)?.id ?? 0;
    this.sql.exec("DELETE FROM d1_outbox WHERE id <= ?", last);
    return rows.length;
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
