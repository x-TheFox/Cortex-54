/**
 * Minimal SQL surface the brain needs. The Durable Object passes `ctx.storage.sql` through `fromDurable`;
 * tests pass an in-memory node:sqlite adapter. Keeping this narrow is what makes the pulse testable in Node.
 */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface SqlLike {
  exec<T extends Row = Row>(query: string, ...bindings: SqlValue[]): T[];
  /** Rows read/written so far (for the free-tier meter). */
  readonly stats: { rowsRead: number; rowsWritten: number };
}

export function one<T extends Row>(sql: SqlLike, query: string, ...bindings: SqlValue[]): T | null {
  return sql.exec<T>(query, ...bindings)[0] ?? null;
}

export function getKV(sql: SqlLike, key: string): string | null {
  return one<{ value: string }>(sql, "SELECT value FROM settings WHERE key = ?", key)?.value ?? null;
}

export function setKV(sql: SqlLike, key: string, value: string, now: number): void {
  sql.exec(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    value,
    now,
  );
}
