import type { WorkflowDispatcher } from "./dispatch.ts";
import { one, type SqlLike } from "./store.ts";

/**
 * Job queue for desktop runners (ADR-065). In cloud mode without GitHub (private repo, or a customer with no GitHub
 * at all) the brain still "dispatches" its research, Kronos, dossier and Governor jobs, but into this queue; the
 * user's Savant desktop app (or `savant runner`) claims them over an HMAC-signed endpoint, runs them on its own
 * machine and posts the batches back to /ingest/batch. One unclaimed job per key (like GitHub's concurrency groups);
 * a claim that never reports back is released after `staleMs` so another runner can take it.
 */
export class QueueDispatcher implements WorkflowDispatcher {
  constructor(
    private readonly sql: SqlLike,
    private readonly now: () => number,
    private readonly staleMs = 3 * 3_600_000,
  ) {}

  static keyFor(workflow: string, inputs: Record<string, string>): string {
    if (workflow === "governor.yml") return `governor${inputs.weekly === "true" ? "-weekly" : ""}`;
    return inputs.job === "dossier"
      ? `dossier-${inputs.symbol ?? "?"}-${inputs.mode ?? "case"}`
      : (inputs.job ?? "?");
  }

  async dispatch(workflow: string, inputs: Record<string, string>): Promise<void> {
    const key = QueueDispatcher.keyFor(workflow, inputs);
    if (one(this.sql, "SELECT id FROM job_queue WHERE key = ? AND claimed_at IS NULL", key)) return;
    this.sql.exec(
      "INSERT INTO job_queue (workflow, key, inputs_json, created_at) VALUES (?, ?, ?, ?)",
      workflow,
      key,
      JSON.stringify(inputs),
      this.now(),
    );
  }

  /** Oldest unclaimed job (or a stale claim) for `runner`, or null. */
  claim(runner: string): { id: number; workflow: string; inputs: Record<string, string> } | null {
    const now = this.now();
    this.sql.exec(
      "DELETE FROM job_queue WHERE claimed_at IS NOT NULL AND claimed_at < ?",
      now - 2 * this.staleMs,
    );
    this.sql.exec("DELETE FROM job_queue WHERE created_at < ?", now - 24 * 3_600_000); // a job nobody ran in a day is stale data
    const row = one<{ id: number; workflow: string; inputs_json: string }>(
      this.sql,
      "SELECT id, workflow, inputs_json FROM job_queue WHERE claimed_at IS NULL OR claimed_at < ? ORDER BY id LIMIT 1",
      now - this.staleMs,
    );
    if (!row) return null;
    this.sql.exec(
      "UPDATE job_queue SET claimed_at = ?, claimed_by = ? WHERE id = ?",
      now,
      runner.slice(0, 60),
      row.id,
    );
    return {
      id: row.id,
      workflow: row.workflow,
      inputs: JSON.parse(row.inputs_json) as Record<string, string>,
    };
  }

  depth(): number {
    return (
      one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM job_queue WHERE claimed_at IS NULL")?.n ?? 0
    );
  }
}
