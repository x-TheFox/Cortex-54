/**
 * Batch-job dispatcher (ADR-032). GitHub's free scheduler drops most runs (first night: 2 of ~16 watchdog
 * slots, 3 of ~10 research slots), so the brain's pulse starts the batch workflows itself through the
 * workflow_dispatch API. The GitHub crons stay as a backup and skip themselves when a dispatched run already
 * happened. Pure except for the injected dispatcher.
 */

export interface WorkflowDispatcher {
  /** Start a workflow on main. Throws on a non-2xx response. */
  dispatch(workflow: string, inputs: Record<string, string>): Promise<void>;
}

export interface DispatchJob {
  key: string;
  workflow: string;
  cron: string; // UTC, the same expression as the workflow's own schedule
  inputs: Record<string, string>;
}

/** Mirrors the `schedule:` blocks of research.yml and governor.yml (a test keeps them in sync). */
export const DISPATCH_JOBS: readonly DispatchJob[] = [
  { key: "crypto", workflow: "research.yml", cron: "7 */4 * * *", inputs: { job: "crypto" } },
  { key: "equity-open", workflow: "research.yml", cron: "40 12 * * 1-5", inputs: { job: "equity" } },
  { key: "equity-close", workflow: "research.yml", cron: "20 21 * * 1-5", inputs: { job: "equity" } },
  { key: "world", workflow: "research.yml", cron: "17 * * * *", inputs: { job: "world" } },
  { key: "options-open", workflow: "research.yml", cron: "50 14 * * 1-5", inputs: { job: "options" } },
  { key: "options-close", workflow: "research.yml", cron: "40 19 * * 1-5", inputs: { job: "options" } },
  { key: "screeners", workflow: "research.yml", cron: "45 14 * * *", inputs: { job: "screeners" } },
  { key: "kronos", workflow: "research.yml", cron: "37 */4 * * *", inputs: { job: "kronos" } },
  { key: "backtest", workflow: "research.yml", cron: "13 7 * * 0", inputs: { job: "backtest" } },
  { key: "governor", workflow: "governor.yml", cron: "23 6 * * 1-6", inputs: { weekly: "false" } },
  { key: "governor-weekly", workflow: "governor.yml", cron: "23 6 * * 0", inputs: { weekly: "true" } },
];

/** Late slots older than this are skipped (the next slot will come). */
export const DISPATCH_GRACE_MS = 20 * 60_000;

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepRaw] = part.split("/") as [string, string | undefined];
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = 59;
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map(Number) as [number, number];
    } else {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : 59;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Five-field cron (minute hour day-of-month month day-of-week; Sunday = 0), evaluated in UTC. */
export function cronMatches(expr: string, ms: number): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`bad cron: ${expr}`);
  const d = new Date(ms);
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  return (
    fieldMatches(m, d.getUTCMinutes()) &&
    fieldMatches(h, d.getUTCHours()) &&
    fieldMatches(dom, d.getUTCDate()) &&
    fieldMatches(mon, d.getUTCMonth() + 1) &&
    fieldMatches(dow, d.getUTCDay())
  );
}

/** The most recent minute ≤ now that matches `expr`, looking back at most `lookbackMs`. */
export function latestSlot(expr: string, now: number, lookbackMs = DISPATCH_GRACE_MS): number | null {
  const start = Math.floor(now / 60_000) * 60_000;
  for (let t = start; t >= now - lookbackMs; t -= 60_000) if (cronMatches(expr, t)) return t;
  return null;
}

/** Jobs whose latest slot (within the grace window) has not been dispatched yet. */
export function dueJobs(now: number, last: Record<string, number>): { job: DispatchJob; slot: number }[] {
  const out: { job: DispatchJob; slot: number }[] = [];
  for (const job of DISPATCH_JOBS) {
    const slot = latestSlot(job.cron, now);
    if (slot !== null && slot > (last[job.key] ?? 0)) out.push({ job, slot });
  }
  return out;
}

/** workflow_dispatch through the GitHub REST API with a fine-grained token (Actions: write on one repo). */
export class GitHubDispatcher implements WorkflowDispatcher {
  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly guard: () => void = () => undefined,
  ) {}

  async dispatch(workflow: string, inputs: Record<string, string>): Promise<void> {
    this.guard();
    const r = await fetch(
      `https://api.github.com/repos/${this.repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "cortex-54",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs }),
      },
    );
    if (!r.ok)
      throw new Error(`GitHub dispatch ${workflow} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}
