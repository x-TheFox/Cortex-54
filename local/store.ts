import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlLike, SqlValue } from "../src/cortex/store.ts";
import type { D1Like } from "../src/journal/Journal.ts";

/**
 * Local-mode storage (ADR-064): the Durable Object's hot state and D1's journal as two SQLite files. Same SQL, same
 * migrations, same append-only triggers, so local and cloud behave identically and a journal can move between them.
 */

function open(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
  return db;
}

export function fileSql(path: string): SqlLike & { db: DatabaseSync } {
  const db = open(path);
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
      stats.rowsWritten += Number(stmt.run(...bindings).changes);
      return [];
    },
  };
}

export interface LocalD1 extends D1Like {
  db: DatabaseSync;
  prepare(query: string): {
    bind(...values: unknown[]): {
      query: string;
      values: unknown[];
      all(): Promise<{ results: unknown[] }>;
      first<T>(): Promise<T | null>;
    };
  };
}

/** A D1 stand-in with every migration in `migrationsDir` applied once (tracked in `_local_migrations`). */
export function fileD1(path: string, migrationsDir: string): LocalD1 {
  const db = open(path);
  db.exec("CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  if (existsSync(migrationsDir)) {
    const done = new Set(
      (db.prepare("SELECT name FROM _local_migrations").all() as { name: string }[]).map((r) => r.name),
    );
    for (const f of readdirSync(migrationsDir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      if (done.has(f)) continue;
      db.exec("BEGIN");
      try {
        db.exec(readFileSync(join(migrationsDir, f), "utf8"));
        db.prepare("INSERT INTO _local_migrations (name, at) VALUES (?, ?)").run(f, Date.now());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw new Error(`migration ${f} failed: ${String(e)}`);
      }
    }
  }
  const self: LocalD1 = {
    db,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const vals = values as SqlValue[];
          return {
            query,
            values,
            async all() {
              return { results: db.prepare(query).all(...vals) as unknown[] };
            },
            async first<T>() {
              return (db.prepare(query).get(...vals) as T | undefined) ?? null;
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
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
