import { DurableObject } from "cloudflare:workers";
import { AlpacaClient, AlpacaMarketData } from "../broker/AlpacaClient.ts";
import type { BrokerApi } from "../broker/types.ts";
import { InvocationMeter } from "../budget/FreeTierBudget.ts";
import { DiscordNotifier, NullNotifier, parseChannels } from "../discord/notifier.ts";
import type { Env } from "../env.ts";
import { CONSTITUTION, CONSTITUTION_SHA256, DOCTRINE, DOCTRINE_SHA256 } from "../generated/config.ts";
import type { AccountId } from "../lib/ids.ts";
import { Brain, type StatusView } from "./Brain.ts";
import { HOT_SCHEMA, HOT_SCHEMA_VERSION } from "./hot-schema.ts";
import { getKV, type Row, type SqlLike, type SqlValue } from "./store.ts";

export interface Health {
  name: string;
  now: number;
  last_pulse_at: number | null;
  next_alarm_at: number | null;
  constitution_sha256: string;
  doctrine_sha256: string;
  hot_schema_version: number;
  accounts_configured: AccountId[];
}

/**
 * Host for the Brain (docs/ARCHITECTURE.md §2). Wires bindings/secrets into the Brain, owns the alarm, and
 * exposes RPC for the router. All trading logic lives in Brain so it can be tested in Node.
 */
export class AgentCortexDO extends DurableObject<Env> {
  private readonly sql: SqlLike;
  private readonly meter = { current: new InvocationMeter(DOCTRINE.budgets.per_invocation.subrequests - 5) };
  private readonly brain: Brain;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = fromDurable(ctx.storage.sql);
    const guard = () => this.meter.current.guard();

    const brokers: Partial<Record<AccountId, BrokerApi>> = {};
    const paper = DOCTRINE.accounts.PAPER;
    const live = DOCTRINE.accounts.LIVE;
    if (paper && env.ALPACA_PAPER_KEY_ID && env.ALPACA_PAPER_SECRET) {
      brokers.PAPER = new AlpacaClient(
        paper.alpaca_base_url,
        { keyId: env.ALPACA_PAPER_KEY_ID, secret: env.ALPACA_PAPER_SECRET },
        guard,
      );
    }
    if (live && env.ALPACA_LIVE_KEY_ID && env.ALPACA_LIVE_SECRET) {
      brokers.LIVE = new AlpacaClient(
        live.alpaca_base_url,
        { keyId: env.ALPACA_LIVE_KEY_ID, secret: env.ALPACA_LIVE_SECRET },
        guard,
      );
    }
    const dataKey =
      env.ALPACA_PAPER_KEY_ID && env.ALPACA_PAPER_SECRET
        ? { keyId: env.ALPACA_PAPER_KEY_ID, secret: env.ALPACA_PAPER_SECRET }
        : env.ALPACA_LIVE_KEY_ID && env.ALPACA_LIVE_SECRET
          ? { keyId: env.ALPACA_LIVE_KEY_ID, secret: env.ALPACA_LIVE_SECRET }
          : null;

    this.brain = new Brain({
      sql: this.sql,
      d: DOCTRINE,
      c: CONSTITUTION,
      brokers,
      market: dataKey ? new AlpacaMarketData(dataKey, guard) : null,
      notifier: env.DISCORD_BOT_TOKEN
        ? new DiscordNotifier(env.DISCORD_BOT_TOKEN, parseChannels(env.DISCORD_CHANNELS), guard)
        : new NullNotifier(),
      d1: env.DB,
      readKillFlag: async () => (await env.FLAGS.get("killed")) !== null,
      now: () => Date.now(),
    });

    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of HOT_SCHEMA) this.sql.exec(stmt);
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('hot_schema_version', ?)",
        String(HOT_SCHEMA_VERSION),
      );
      this.brain.init({
        constitution_sha256: CONSTITUTION_SHA256,
        doctrine_sha256: DOCTRINE_SHA256,
        hot_schema_version: HOT_SCHEMA_VERSION,
        accounts: Object.keys(brokers),
      });
      // Self-starting heart: no cron needed (ADR-021).
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 1_000);
    });
  }

  /** Fresh subrequest budget per invocation (Workers Free: 50). */
  private begin(): void {
    this.meter.current = new InvocationMeter(DOCTRINE.budgets.per_invocation.subrequests - 5);
    this.brain.budget.add("do_requests", 1, Date.now());
  }

  async ensureAlarm(): Promise<number> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  override async alarm(): Promise<void> {
    this.meter.current = new InvocationMeter(DOCTRINE.budgets.per_invocation.subrequests - 5);
    let next = DOCTRINE.cadence.pulse_seconds_exposed;
    try {
      const report = await this.brain.pulse();
      next = report.nextPulseSeconds;
    } catch (e) {
      console.error("[cortex] pulse failed", e);
    } finally {
      // Always re-arm: a pulse error must never stop the heart.
      await this.ctx.storage.setAlarm(Date.now() + next * 1000);
    }
  }

  async health(): Promise<Health> {
    const last = getKV(this.sql, "last_pulse_at");
    return {
      name: this.env.CORTEX_DO_NAME,
      now: Date.now(),
      last_pulse_at: last === null ? null : Number(last),
      next_alarm_at: await this.ctx.storage.getAlarm(),
      constitution_sha256: CONSTITUTION_SHA256,
      doctrine_sha256: DOCTRINE_SHA256,
      hot_schema_version: HOT_SCHEMA_VERSION,
      accounts_configured: this.brain
        .status()
        .accounts.filter((a) => a.configured)
        .map((a) => a.account),
    };
  }

  // ---- operator RPC (called by the router after Discord signature + operator checks) ----

  status(): StatusView {
    this.begin();
    return this.brain.status();
  }

  pause(account: AccountId, by: string): string {
    this.begin();
    return this.brain.pause(account, by);
  }

  resume(account: AccountId, by: string): string {
    this.begin();
    return this.brain.resume(account, by);
  }

  setDial(account: AccountId, stop: number, by: string, ratified: boolean): string {
    this.begin();
    return this.brain.setDial(account, stop, by, ratified);
  }

  unlock(account: AccountId, postmortem: string, by: string): string {
    this.begin();
    return this.brain.unlock(account, postmortem, by);
  }

  async flatten(account: AccountId, by: string): Promise<string> {
    this.begin();
    const msg = await this.brain.flatten(account, `operator ${by}`);
    await this.brain.flushJournal();
    return msg;
  }

  async decide(
    contractId: string,
    account: AccountId,
    decision: "APPROVE" | "VETO",
    by: string,
  ): Promise<string> {
    this.begin();
    const msg = await this.brain.decide(contractId, account, decision, by);
    await this.brain.flushJournal();
    return msg;
  }
}

/** Adapts Durable Object SqlStorage to the brain's SqlLike (and counts rows for the free-tier meter). */
function fromDurable(sql: SqlStorage): SqlLike {
  const stats = { rowsRead: 0, rowsWritten: 0 };
  return {
    stats,
    exec<T extends Row>(query: string, ...bindings: SqlValue[]): T[] {
      const cursor = sql.exec(query, ...bindings);
      const rows = cursor.toArray() as unknown as T[];
      stats.rowsRead += cursor.rowsRead;
      stats.rowsWritten += cursor.rowsWritten;
      return rows;
    },
  };
}
