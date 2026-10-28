import { DurableObject } from "cloudflare:workers";
import { AlpacaClient, AlpacaMarketData } from "../broker/AlpacaClient.ts";
import type { BrokerApi } from "../broker/types.ts";
import { InvocationMeter } from "../budget/FreeTierBudget.ts";
import { WorkersAiClef } from "../clef/ClefClient.ts";
import { WorkersAiClairic } from "../clef/clairic.ts";
import { buildPool, parsePool, poolRouter } from "../court/pool.ts";
import { buildProviders } from "../court/providers.ts";
import { DiscordNotifier, type Notifier, NullNotifier, parseChannels } from "../discord/notifier.ts";
import type { Env } from "../env.ts";
import {
  CALIBRATION,
  CONSTITUTION,
  CONSTITUTION_SHA256,
  DOCTRINE,
  DOCTRINE_SHA256,
  SCAR_TISSUE,
} from "../generated/config.ts";
import { hubFromEnv } from "../hub/client.ts";
import type { AccountId } from "../lib/ids.ts";
import { InboxNotifier, readFeed } from "../notify/inbox.ts";
import { ntfyUrl, PushNotifier } from "../notify/push.ts";
import { Brain, parseKillFlag, type SloView, type StatusView } from "./Brain.ts";
import { GitHubDispatcher } from "./dispatch.ts";
import { HOT_SCHEMA, HOT_SCHEMA_VERSION } from "./hot-schema.ts";
import { LabNotifier, labDoctrine } from "./lab.ts";
import { QueueDispatcher } from "./queue.ts";
import { getKV, type Row, type SqlLike, type SqlValue, setKV } from "./store.ts";

export interface Health {
  name: string;
  now: number;
  last_pulse_at: number | null;
  next_alarm_at: number | null;
  constitution_sha256: string;
  doctrine_sha256: string;
  hot_schema_version: number;
  accounts_configured: AccountId[];
  /** Consecutive failed Discord sends; the sentinel alerts through its own webhook at ≥ 5. */
  discord_fail_streak: number;
  /** Audit W1-39: constitution invariants violated right now (empty = fine); the sentinel alerts on any. */
  policy_violations: Record<string, number>;
  /** Audit W1-32: freshness, backlog, budget and failure counts at a glance. */
  slo: SloView;
}

/**
 * Host for the Brain (docs/ARCHITECTURE.md §2). Wires bindings/secrets into the Brain, owns the alarm, and
 * exposes RPC for the router. All trading logic lives in Brain so it can be tested in Node.
 */
export class AgentCortexDO extends DurableObject<Env> {
  private readonly sql: SqlLike;
  private readonly meter = { current: new InvocationMeter(DOCTRINE.budgets.per_invocation.subrequests - 5) };
  private readonly brain: Brain;
  /** ADR-065: research jobs for linked desktop runners (RUNNER_MODE=queue). */
  private readonly queue: QueueDispatcher;

  /** LabCortexDO sets this (ADR-045): a second brain on the LAB paper account, journal and doctrine view. */
  static readonly lab: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = fromDurable(ctx.storage.sql);
    this.queue = new QueueDispatcher(this.sql, () => Date.now());
    const guard = () => this.meter.current.guard();
    const lab = (this.constructor as typeof AgentCortexDO).lab;
    if (lab) {
      this.brain = labBrain(this.sql, env, guard);
      this.bootBrain(ctx, lab ? ["PAPER"] : []);
      return;
    }

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

    // ADR-072: the model pool = built-in free providers + the user's own endpoints (LLM_POOL), in round robin
    const pool = parsePool(env.LLM_POOL);
    const built = buildPool(DOCTRINE, buildProviders(env), pool);
    const d = built.d;
    this.brain = new Brain({
      sql: this.sql,
      d,
      c: CONSTITUTION,
      brokers,
      market: dataKey ? new AlpacaMarketData(dataKey, guard) : null,
      // ADR-071: every card lands in the app's feed first; Discord and phone pushes are optional extras
      notifier: new InboxNotifier(
        this.sql,
        withPush(
          env.DISCORD_BOT_TOKEN
            ? new DiscordNotifier(
                env.DISCORD_BOT_TOKEN,
                parseChannels(env.DISCORD_CHANNELS),
                guard,
                undefined,
                discordReport(this.sql),
              )
            : new NullNotifier(),
          env,
          guard,
        ),
        () => Date.now(),
      ),
      d1: env.DB,
      readKillFlag: async () => parseKillFlag(await env.FLAGS.get("killed")),
      clef: new WorkersAiClef(env.AI),
      clairic: new WorkersAiClairic(env.AI),
      llm: poolRouter(built, pool.prefs),
      calibration: CALIBRATION,
      scar: SCAR_TISSUE,
      // ADR-065: RUNNER_MODE=queue hands jobs to a linked desktop runner; otherwise GitHub Actions when configured
      dispatcher:
        env.RUNNER_MODE === "queue"
          ? this.queue
          : env.GITHUB_REPO && env.GH_DISPATCH_TOKEN
            ? new GitHubDispatcher(env.GITHUB_REPO, env.GH_DISPATCH_TOKEN, guard)
            : null,
      http: (u, i) => {
        guard();
        return fetch(u, i);
      },
      hub: hubFromEnv(env as unknown as Record<string, string | undefined>),
      now: () => Date.now(),
    });

    this.bootBrain(ctx, Object.keys(brokers));
  }

  private bootBrain(ctx: DurableObjectState, accounts: string[]): void {
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of HOT_SCHEMA) this.sql.exec(stmt);
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('hot_schema_version', ?)",
        String(HOT_SCHEMA_VERSION),
      );
      const db = (this.constructor as typeof AgentCortexDO).lab ? this.env.DB_LAB : this.env.DB;
      await this.brain
        .reanchorJournal(async () => {
          const r = await db
            .prepare("SELECT seq, row_sha256 FROM journal ORDER BY seq DESC LIMIT 1")
            .first<{ seq: number; row_sha256: string }>();
          return r ? { seq: r.seq, sha: r.row_sha256 } : null;
        })
        .catch(() => "fresh"); // D1 down at boot: keep going; a reset is rare and the next boot retries
      this.brain.init({
        constitution_sha256: CONSTITUTION_SHA256,
        doctrine_sha256: DOCTRINE_SHA256,
        hot_schema_version: HOT_SCHEMA_VERSION,
        accounts,
        ...((this.constructor as typeof AgentCortexDO).lab ? { lab: true } : {}),
      });
      // Self-starting heart: no cron needed (ADR-021).
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 1_000);
    });
  }

  /** True while an alarm pulse is running (its awaits let RPCs interleave). */
  private pulsing = false;

  /**
   * Fresh subrequest budget per invocation (Workers Free: 50). Audit W1-18: an RPC that arrives while a pulse is in
   * flight shares the pulse's meter instead of resetting it, so the pulse can't be handed a fresh budget mid-way.
   */
  private begin(): void {
    if (!this.pulsing)
      this.meter.current = new InvocationMeter(DOCTRINE.budgets.per_invocation.subrequests - 5);
    const now = Date.now();
    this.brain.budget.add("do_requests", 1, now);
    // audit F-A3-05: every RPC here started as a Worker request, so this is a floor on worker_requests (404s and
    // refused signatures never reach the brain), so real exhaustion now trips THRIFT/REDUCE_ONLY
    this.brain.budget.add("worker_requests", 1, now);
  }

  async ensureAlarm(): Promise<number> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return existing;
    // A running alarm handler has no alarm set (the runtime clears it while the handler runs); the pulse re-arms it
    // when it finishes. Live data 2026-10-27: every "lost" alarm (40 PAPER, 112 LAB) had a ~61 s gap, i.e. the cron
    // landed mid-pulse, logged a false loss and started a second, overlapping pulse.
    if (this.pulsing) return Date.now() + 60_000;
    const at = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(at);
    // Audit W1-15: a lost alarm was restored silently, so how often it happens was unknowable.
    const last = Number(getKV(this.sql, "last_pulse_at") ?? 0);
    this.brain.noteAlarmLost(last > 0 ? Math.round((Date.now() - last) / 1000) : null);
    return at;
  }

  override async alarm(): Promise<void> {
    this.meter.current = new InvocationMeter(DOCTRINE.budgets.per_invocation.subrequests - 5);
    this.pulsing = true;
    let next = DOCTRINE.cadence.pulse_seconds_exposed;
    try {
      const t0 = Date.now();
      const report = await this.brain.pulse();
      next = report.nextPulseSeconds;
      // Audit W1-23: one structured line per pulse for Workers Logs (free; queryable, unlike Discord embeds).
      console.log(
        JSON.stringify({
          kind: "pulse",
          brain: (this.constructor as typeof AgentCortexDO).lab ? "LAB" : "PRIMARY",
          ok: true,
          ms: Date.now() - t0,
          mode: report.budgetMode,
          kill: report.kill,
          entries: report.entries,
          exits: report.exits,
          court: report.courtContracts,
          tier2: report.tier2,
          next_s: next,
        }),
      );
      if ((getKV(this.sql, "pulse_error_streak") ?? "0") !== "0")
        setKV(this.sql, "pulse_error_streak", "0", Date.now());
    } catch (e) {
      // Back off while broken (audit W1-15): retrying at the fastest cadence burned budget during incidents.
      const n = Number(getKV(this.sql, "pulse_error_streak") ?? 0) + 1;
      setKV(this.sql, "pulse_error_streak", String(n), Date.now());
      next = Math.min(
        DOCTRINE.cadence.pulse_seconds_exposed * 2 ** Math.min(n, 6),
        DOCTRINE.cadence.pulse_seconds_flat,
      );
      console.error(
        JSON.stringify({
          kind: "pulse",
          brain: (this.constructor as typeof AgentCortexDO).lab ? "LAB" : "PRIMARY",
          ok: false,
          streak: n,
          error: String(e).slice(0, 300),
        }),
      );
    } finally {
      this.pulsing = false;
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
      discord_fail_streak: Number(getKV(this.sql, "discord_fail_streak") ?? 0),
      policy_violations: this.brain.policyViolations(),
      slo: this.brain.slo(),
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

  /** Research batch from GitHub Actions; the router has already verified the HMAC. */
  async ingest(batch: unknown): Promise<{ ok: boolean; message: string }> {
    this.begin();
    return this.brain.ingestBatch(batch);
  }

  async court(symbol: string, by: string): Promise<string> {
    this.begin();
    return this.brain.requestCourt(symbol, by);
  }

  why(symbol: string): string {
    this.begin();
    return this.brain.why(symbol);
  }

  async roast(symbol: string, thesis: string, by: string): Promise<string> {
    this.begin();
    return this.brain.requestRoast(symbol, thesis, by);
  }

  async feed(q: {
    channel: string | null;
    before: number | null;
    limit: number;
    exclude?: string[];
  }): Promise<unknown> {
    return readFeed(this.sql, q);
  }

  async book(): Promise<string> {
    this.begin();
    const b = await this.brain.bookReview(true);
    await this.brain.flushJournal();
    return b
      ? `📒 Book review posted to the feed (REPORTS) (${b.lines.length} position(s)).`
      : "Book review unavailable (no market data).";
  }

  universe(): string {
    this.begin();
    return this.brain.universeView();
  }

  /** ADR-065: a linked desktop runner asks for its next job (the router has verified the HMAC). */
  claimJob(runner: string): { id: number; workflow: string; inputs: Record<string, string> } | null {
    this.begin();
    return this.queue.claim(runner);
  }

  async resetAccount(account: AccountId, by: string): Promise<{ ok: boolean; message: string }> {
    this.begin();
    return this.brain.resetAccount(account, by);
  }

  // ---- web terminal (ADR-034) ----

  consumeOnce(id: string): boolean {
    this.begin();
    return this.brain.consumeOnce(id);
  }

  isRevoked(id: string): boolean {
    this.begin();
    return this.brain.isRevoked(id);
  }

  memory(): ReturnType<Brain["memoryView"]> {
    this.begin();
    return this.brain.memoryView();
  }

  forecast(symbol: string): ReturnType<Brain["forecastView"]> {
    this.begin();
    return this.brain.forecastView(symbol);
  }

  equity(days: number): ReturnType<Brain["equityHistory"]> {
    this.begin();
    return this.brain.equityHistory(Date.now() - Math.min(35, Math.max(1, days)) * 86_400_000);
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

/** ADR-062: phone pushes via ntfy when NTFY_TOPIC is set (PAPER/LIVE brain only; LAB stays in #agent-terminal). */
function withPush(inner: Notifier, env: Env, guard: () => void): Notifier {
  const url = ntfyUrl(env.NTFY_TOPIC, env.NTFY_URL);
  return url ? new PushNotifier(inner, url, guard) : inner;
}

/** ADR-045: LAB brain wiring — LAB paper keys, LAB journal, LAB doctrine view, no AI and no dispatching. */
function labBrain(sql: SqlLike, env: Env, guard: () => void): Brain {
  const paper = DOCTRINE.accounts.PAPER;
  const brokers: Partial<Record<AccountId, BrokerApi>> = {};
  const key =
    env.ALPACA_LAB_KEY_ID && env.ALPACA_LAB_SECRET
      ? { keyId: env.ALPACA_LAB_KEY_ID, secret: env.ALPACA_LAB_SECRET }
      : null;
  if (paper && key) brokers.PAPER = new AlpacaClient(paper.alpaca_base_url, key, guard);
  const d = labDoctrine(DOCTRINE);
  return new Brain({
    sql,
    d,
    c: CONSTITUTION,
    brokers,
    market: key ? new AlpacaMarketData(key, guard) : null,
    notifier: env.DISCORD_BOT_TOKEN
      ? new LabNotifier(
          new DiscordNotifier(
            env.DISCORD_BOT_TOKEN,
            parseChannels(env.DISCORD_CHANNELS),
            guard,
            undefined,
            discordReport(sql),
          ),
        )
      : new NullNotifier(),
    d1: env.DB_LAB,
    readKillFlag: async () => (await env.FLAGS.get("killed")) !== null,
    clef: null,
    clairic: null,
    llm: null,
    calibration: CALIBRATION,
    scar: SCAR_TISSUE,
    dispatcher: null,
    now: () => Date.now(),
  });
}

/** The LAB brain's Durable Object class (ADR-045): same code, different wiring. */
export class LabCortexDO extends AgentCortexDO {
  static override readonly lab = true;
}

/** Track consecutive Discord send failures in hot KV; /health exposes it so the sentinel can alert (its own path). */
function discordReport(sql: SqlLike): (ok: boolean) => void {
  return (ok) => {
    const now = Date.now();
    const prev = Number(getKV(sql, "discord_fail_streak") ?? 0);
    const next = ok ? 0 : prev + 1;
    if (next !== prev) setKV(sql, "discord_fail_streak", String(next), now);
  };
}
