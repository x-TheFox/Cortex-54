import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SqlLike, SqlValue } from "../../src/cortex/store.ts";
import type { D1Like } from "../../src/journal/Journal.ts";

/** In-memory SQLite implementing the brain's SqlLike (stands in for Durable Object storage). */
export function memorySql(): SqlLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const stats = { rowsRead: 0, rowsWritten: 0 };
  return {
    db,
    stats,
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        const rows = stmt.all(...bindings) as T[];
        stats.rowsRead += rows.length;
        return rows;
      }
      const r = stmt.run(...bindings);
      stats.rowsWritten += Number(r.changes);
      return [];
    },
  };
}

/** A D1 stand-in backed by SQLite with the real migrations applied, so outbox rows must fit the real schema. */
export function memoryD1(): D1Like & { db: DatabaseSync; batches: number; fail: boolean } {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(`migrations/${f}`, "utf8"));
  }
  const self = {
    db,
    batches: 0,
    fail: false,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return { query, values };
        },
      };
    },
    async batch(statements: unknown[]) {
      if (self.fail) throw new Error("D1 unavailable");
      self.batches++;
      db.exec("BEGIN");
      try {
        for (const s of statements as { query: string; values: SqlValue[] }[])
          db.prepare(s.query).run(...s.values);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return [];
    },
  };
  return self;
}
