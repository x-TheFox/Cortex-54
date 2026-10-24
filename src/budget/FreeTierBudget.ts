import type { Doctrine } from "../contracts/doctrine.ts";
import type { SqlLike } from "../cortex/store.ts";

/**
 * Free-tier meter (constitution U6, docs/FREE_TIER_BUDGET.md). Cloudflare free limits hard-fail, so we track
 * our own usage per UTC day and degrade before the platform does:
 *   any resource ≥ thrift_fraction → THRIFT, ≥ hard_stop_fraction (or an observed limit error) → REDUCE_ONLY.
 */
export type BudgetMode = "NORMAL" | "THRIFT" | "REDUCE_ONLY";

export type DailyResource =
  | "do_requests"
  | "do_duration_gb_s"
  | "do_rows_written"
  | "do_rows_read"
  | "d1_rows_written"
  | "d1_rows_read"
  | "worker_requests"
  | "neurons_tier1"
  | "neurons_tier2"
  | "neurons_tier3_fallback"
  | "neurons_clairic"
  | "neurons_reserve";

export const DO_MEMORY_GB = 0.125; // 128 MB billing unit

/** Resources whose burn rate is worth projecting (writes and duration hard-fail at the daily cap). */
const PROJECTED = new Set(["do_rows_written", "d1_rows_written", "do_duration_gb_s", "do_requests"]);
const PROJECTION_SAFETY = 1.15;

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export class FreeTierBudget {
  constructor(
    private readonly sql: SqlLike,
    private readonly d: Doctrine,
  ) {}

  private limitOf(r: DailyResource): number {
    const n = this.d.budgets.workers_ai_neurons_per_day;
    switch (r) {
      case "neurons_tier1":
        return n.tier1;
      case "neurons_tier2":
        return n.tier2;
      case "neurons_tier3_fallback":
        return n.tier3_fallback;
      case "neurons_clairic":
        return n.clairic;
      case "neurons_reserve":
        return n.reserve;
      default:
        return this.d.budgets.daily_limits[r] ?? Number.POSITIVE_INFINITY;
    }
  }

  add(r: DailyResource, amount: number, now: number): void {
    if (amount <= 0) return;
    this.sql.exec(
      "INSERT INTO budget_counters (day, resource, used) VALUES (?, ?, ?) ON CONFLICT(day, resource) DO UPDATE SET used = used + excluded.used",
      utcDay(now),
      r,
      amount,
    );
  }

  used(r: DailyResource, now: number): number {
    const row = this.sql.exec<{ used: number }>(
      "SELECT used FROM budget_counters WHERE day = ? AND resource = ?",
      utcDay(now),
      r,
    )[0];
    return row?.used ?? 0;
  }

  /** Record that the platform itself returned a limit error today; forces REDUCE_ONLY until 00:00 UTC. */
  markLimitHit(resource: string, now: number): void {
    this.sql.exec(
      "INSERT INTO budget_counters (day, resource, used) VALUES (?, ?, 1) ON CONFLICT(day, resource) DO UPDATE SET used = used + 1",
      utcDay(now),
      `limit_hit:${resource}`,
    );
  }

  /** True when a neuron spend fits the tier's allocation (Phase 3 callers). */
  canSpendNeurons(
    tier: "neurons_tier1" | "neurons_tier2" | "neurons_tier3_fallback" | "neurons_clairic",
    neurons: number,
    now: number,
  ): boolean {
    return this.used(tier, now) + neurons <= this.limitOf(tier) * this.d.budgets.hard_stop_fraction;
  }

  snapshot(now: number): {
    mode: BudgetMode;
    worst: { resource: string; fraction: number };
    fractions: Record<string, number>;
    /** Audit W1-16: today's use extrapolated to midnight UTC (rate-limited resources only). */
    projected: { resource: string; fraction: number };
    resets_in_s: number;
  } {
    const rows = this.sql.exec<{ resource: string; used: number }>(
      "SELECT resource, used FROM budget_counters WHERE day = ?",
      utcDay(now),
    );
    const fractions: Record<string, number> = {};
    let worst = { resource: "none", fraction: 0 };
    let limitHit = false;
    for (const { resource, used } of rows) {
      if (resource.startsWith("limit_hit:")) {
        limitHit = true;
        continue;
      }
      if (resource.startsWith("neurons_")) continue; // tier allocations gate their own tier, not the account mode
      const f = used / this.limitOf(resource as DailyResource);
      fractions[resource] = f;
      if (f > worst.fraction) worst = { resource, fraction: f };
    }
    // Projection: a burst early in the day that would exhaust a write budget before midnight goes THRIFT now, not
    // at 70% when it is already too late. Floored at 1 h elapsed so the first minutes don't extrapolate wildly.
    // Only THRIFT (never REDUCE_ONLY) comes from a projection: it is a forecast, not a measurement.
    const dayStart = Date.parse(`${utcDay(now)}T00:00:00Z`);
    const elapsed = Math.max((now - dayStart) / 86_400_000, 1 / 24);
    let projected = { resource: "none", fraction: 0 };
    for (const [resource, f] of Object.entries(fractions)) {
      if (!PROJECTED.has(resource)) continue;
      const pf = (f / elapsed) * PROJECTION_SAFETY;
      if (pf > projected.fraction) projected = { resource, fraction: pf };
    }
    let mode: BudgetMode = "NORMAL";
    if (limitHit || worst.fraction >= this.d.budgets.hard_stop_fraction) mode = "REDUCE_ONLY";
    else if (worst.fraction >= this.d.budgets.thrift_fraction || projected.fraction >= 1) mode = "THRIFT";
    return {
      mode,
      worst,
      fractions,
      projected,
      resets_in_s: Math.round((dayStart + 86_400_000 - now) / 1000),
    };
  }

  /** Keep 14 days of counters for the HUD and the Governor; older rows are dropped. */
  prune(now: number): void {
    this.sql.exec("DELETE FROM budget_counters WHERE day < ?", utcDay(now - 14 * 86_400_000));
  }
}

/** Per-invocation subrequest guard (Workers Free: 50 external, 1,000 to Cloudflare services). */
export class SubrequestBudgetExceeded extends Error {}

export class InvocationMeter {
  external = 0;
  constructor(private readonly maxExternal: number) {}
  guard = (): void => {
    if (this.external >= this.maxExternal) {
      throw new SubrequestBudgetExceeded(`subrequest budget (${this.maxExternal}) exhausted this invocation`);
    }
    this.external++;
  };
  remaining(): number {
    return this.maxExternal - this.external;
  }
}
