import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { CONSTITUTION_SHA256, DOCTRINE, DOCTRINE_SHA256 } from "../generated/config.ts";
import { HOT_SCHEMA, HOT_SCHEMA_VERSION } from "./hot-schema.ts";

export interface Health {
  name: string;
  now: number;
  last_pulse_at: number | null;
  next_alarm_at: number | null;
  constitution_sha256: string;
  doctrine_sha256: string;
  hot_schema_version: number;
}

/**
 * The only brain (docs/ARCHITECTURE.md §2). Phase 0: schema, heartbeat pulse and health only.
 * Phase 1 adds accounts, reconciliation, risk reservations, the order state machine and stops.
 */
export class AgentCortexDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of HOT_SCHEMA) this.sql.exec(stmt);
      this.setMeta("hot_schema_version", String(HOT_SCHEMA_VERSION));
      this.setMeta("constitution_sha256", CONSTITUTION_SHA256);
      this.setMeta("doctrine_sha256", DOCTRINE_SHA256);
    });
  }

  /** Called by the cortex cron every 5 min: self-heal a missing alarm. */
  async ensureAlarm(): Promise<number> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.setMeta("last_pulse_at", String(now));
    // Phase 1: reconcile → Tier 0 → intake → execute → journal (ARCHITECTURE.md §2).
    await this.ctx.storage.setAlarm(now + DOCTRINE.cadence.pulse_seconds_flat * 1_000);
  }

  async health(): Promise<Health> {
    const last = this.getMeta("last_pulse_at");
    return {
      name: this.env.CORTEX_DO_NAME,
      now: Date.now(),
      last_pulse_at: last === null ? null : Number(last),
      next_alarm_at: await this.ctx.storage.getAlarm(),
      constitution_sha256: CONSTITUTION_SHA256,
      doctrine_sha256: DOCTRINE_SHA256,
      hot_schema_version: HOT_SCHEMA_VERSION,
    };
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private getMeta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? row.value : null;
  }
}
