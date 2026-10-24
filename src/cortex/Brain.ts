import {
  type AlpacaAsset,
  type BrokerApi,
  BrokerError,
  type MarketDataApi,
  type Quote,
} from "../broker/types.ts";
import { DO_MEMORY_GB, FreeTierBudget, SubrequestBudgetExceeded, utcDay } from "../budget/FreeTierBudget.ts";
import { CLEF_CONTEXT_TOKENS, type ClefApi, estimateTokens } from "../clef/ClefClient.ts";
import { type CatalystFacts, type ClairicApi, FACT_FIELDS, interpretFacts } from "../clef/clairic.ts";
import { buildTier2, interpretTier2, TIER2_PROMPT_VERSION } from "../clef/tier2.ts";
import {
  buildTier1,
  interpretTier1,
  neuronsFor,
  TIER1_PROMPT_VERSION,
  type TriageItem,
} from "../clef/triage.ts";
import {
  type Batch,
  BatchSchema,
  BeliefSchema,
  FitnessSchema,
  GradeSchema,
  OptionsEventSchema,
  PostmortemSchema,
  ReportCardSchema,
  ReputationSchema,
  ScreenerCandidateSchema,
  WorldCandidateSchema,
} from "../contracts/batch.ts";
import type { Calibration } from "../contracts/calibration.ts";
import type { Constitution } from "../contracts/constitution.ts";
import {
  contractViolations,
  type DecisionContract,
  DecisionContractSchema,
} from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import {
  BearSchema,
  BullSchema,
  buildCourtContract,
  buildSynth,
  COURT_STRATEGY,
  calibrate,
  checkBull,
  interpretSynth,
  PanelOpinionSchema,
  type Rebuttal,
  RebuttalSchema,
  type SeatOpinion,
} from "../court/court.ts";
import { buildEvidence, type Evidence, evidenceForModels, resolveTradeable } from "../court/evidence.ts";
import type { HopAttempt, LlmRouter } from "../court/llm.ts";
import {
  BEAR_PROMPT_VERSION,
  BEAR_SCHEMA,
  BEAR_SYSTEM,
  BULL_PROMPT_VERSION,
  BULL_SCHEMA,
  BULL_SYSTEM,
  PANEL_PROMPT_VERSION,
  PANEL_SCHEMA,
  PANEL_SEATS,
  panelSystem,
  REBUTTAL_PROMPT_VERSION,
  REBUTTAL_SCHEMA,
  REBUTTAL_SYSTEM,
} from "../court/prompts.ts";
import { COLORS, type DiscordMessage, type Notifier } from "../discord/notifier.ts";
import { type D1Like, Journal } from "../journal/Journal.ts";
import {
  type AccountId,
  canonicalSymbol,
  clientOrderId,
  isCryptoSymbol,
  type OrderRole,
  uuidv7,
} from "../lib/ids.ts";
import { dec, defaultTick, roundPrice, toCents } from "../lib/num.ts";
import { sha256Hex } from "../lib/sha256.ts";
import { type Band, evaluateBreaker } from "../risk/CircuitBreakerLadder.ts";
import { correlationVeto } from "../risk/correlation.ts";
import { type Arena, modeledPaperCostCents, roundTripFeeRate } from "../risk/fees.ts";
import { type AccountView, type AssetView, validateEntry } from "../risk/PreTradeValidator.ts";
import { effectiveRung, type RungName } from "../risk/rungs.ts";
import { type Facts, type ScarTissue, scarLessons, scarVetoes } from "../risk/scar.ts";
import {
  BOUNCE_ID,
  bounceParams,
  bounceSignal,
  INVERSE_ID,
  inverseParams,
  inverseSignal,
} from "../strategy/BearAndBounce.ts";
import {
  RSI2_ID,
  rsi2Params,
  rsi2Signal,
  TOM_ID,
  TREND_ID,
  tomParams,
  tomSignal,
  trendParams,
  trendSignal,
} from "../strategy/Classics.ts";
import {
  STRATEGY_ID as BASELINE_ID,
  baselineParams,
  baselineSignal,
  regimeProxyRiskOn,
} from "../strategy/CryptoBreakoutBaseline.ts";
import { atr, type Bar } from "../strategy/indicators.ts";
import {
  KRONOS_ID,
  type KronosForecast,
  KronosPayloadSchema,
  kronosParams,
  kronosSignal,
} from "../strategy/KronosForecast.ts";
import { dueJobs, type WorkflowDispatcher } from "./dispatch.ts";
import { getKV, one, type SqlLike, setKV } from "./store.ts";

export const ACCOUNTS: AccountId[] = ["PAPER", "LIVE"];
/** Triage queue cap (news + future screener candidates) — keeps DO storage and row writes bounded. */
export const TRIAGE_QUEUE_MAX = 300;
/** Valid dial stops (ADR-024): 0 shadow; PAPER trades at 2; LIVE trades at 3; 4 = colleague mode. */
export const DIAL_STOPS: Record<AccountId, number[]> = { PAPER: [0, 2, 4], LIVE: [0, 3, 4] };
const OPEN_STATES = [
  "PLANNED",
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "pending_cancel",
  "held",
  "accepted_for_bidding",
  "pending_replace",
  "calculated",
];
const OPEN_SQL = OPEN_STATES.map((s) => `'${s}'`).join(",");

type AccountRow = {
  account: AccountId;
  broker_equity_cents: number | null;
  modeled_cost_cents: number;
  hwm_cents: number | null;
  day_start_equity_cents: number | null;
  cash_cents: number | null;
  buying_power_cents: number | null;
  rung: RungName;
  autonomy_stop: number;
  breaker: Band;
  locked: number;
  mode: "NORMAL" | "PAUSED" | "REDUCE_ONLY";
  mode_reason: string | null;
  reconciled_at: number | null;
  last_error: string | null;
  day: string | null;
  orders_today: number;
};

type PositionRow = {
  account: AccountId;
  symbol: string;
  arena: Arena;
  contract_id: string;
  qty: string;
  avg_entry: string;
  stop_price: string;
  target_price: string;
  fee_rt: number;
  opened_at: number;
  max_hold_until: number;
  broker_stop_coid: string | null;
  state: "OPEN" | "EXITING";
  exit_reason: string | null;
};

type OrderRow = {
  client_order_id: string;
  account: AccountId;
  contract_id: string;
  role: OrderRole;
  attempt: number;
  broker_order_id: string | null;
  state: string;
  side: "buy" | "sell";
  symbol: string;
  arena: Arena;
  order_type: string;
  tif: string;
  qty: string;
  limit_price: string | null;
  stop_price: string | null;
  filled_qty: string;
  avg_fill_price: string | null;
  risk_cents: number;
  notional_cents: number;
  pulses_unfilled: number;
  created_at: number;
  updated_at: number;
};

export type KillState = "KILLED" | "CLEAR" | "UNKNOWN";

export interface BrainDeps {
  sql: SqlLike;
  d: Doctrine;
  c: Constitution;
  brokers: Partial<Record<AccountId, BrokerApi>>;
  market: MarketDataApi | null;
  notifier: Notifier;
  d1: D1Like | null;
  readKillFlag: () => Promise<boolean>;
  now: () => number;
  /** Workers AI Clef (Tier 1/2). Null disables the funnel; trading is unaffected. */
  clef?: ClefApi | null;
  clairic?: ClairicApi | null;
  /** Free-tier LLM chains for the court (Tier 3). Null disables the court. */
  llm?: LlmRouter | null;
  /** Governor-produced calibration maps (config/calibration.json). */
  calibration?: Calibration | null;
  /** Starts the GitHub batch workflows on schedule (ADR-032). Null leaves scheduling to GitHub's own crons. */
  dispatcher?: WorkflowDispatcher | null;
  /** Operator-merged scar tissue (config/scar-tissue.yaml). Hard filters veto entries; context rules are lessons. */
  scar?: ScarTissue | null;
}

export interface PulseReport {
  at: number;
  budgetMode: string;
  kill: KillState;
  accounts: Partial<Record<AccountId, { ok: boolean; error?: string; band?: Band; positions?: number }>>;
  contracts: number;
  entries: number;
  exits: number;
  flushed: number;
  newsQueued: number;
  triaged: number;
  promoted: number;
  tier2: number;
  courtContracts: number;
  nextPulseSeconds: number;
}

export interface StatusView {
  now: number;
  lastPulseAt: number | null;
  budget: ReturnType<FreeTierBudget["snapshot"]>;
  journalHead: { seq: number; sha: string };
  outboxPending: number;
  /** Hourly equity samples (last 7 days) per account: [epoch ms, USD]. */
  equity: Partial<Record<AccountId, number[][]>>;
  regimes: {
    arena: string;
    posture: string;
    score: number | null;
    ceiling: number | null;
    ageMinutes: number;
    fresh: boolean;
    source: string;
  }[];
  accounts: {
    account: AccountId;
    configured: boolean;
    equityUsd: number | null;
    brokerEquityUsd: number | null;
    modeledCostUsd: number;
    hwmUsd: number | null;
    rung: RungName;
    autonomyStop: number;
    breaker: Band;
    locked: boolean;
    mode: string;
    modeReason: string | null;
    reconciledAt: number | null;
    lastError: string | null;
    ordersToday: number;
    positions: {
      symbol: string;
      qty: string;
      avgEntry: string;
      stop: string;
      target: string;
      state: string;
      brokerStop: boolean;
    }[];
    openOrders: { coid: string; role: string; symbol: string; side: string; qty: string; state: string }[];
  }[];
}

/**
 * The trading brain (docs/ARCHITECTURE.md §2–§5). Owns all decisions; the Durable Object only wires it up.
 * Every method that mutates risk state does its checks and reservations synchronously before awaiting.
 */
export class Brain {
  readonly journal: Journal;
  readonly budget: FreeTierBudget;
  /** Most recent risk-engine rejection reasons per contract (for the courtroom card). */
  private readonly lastRejections = new Map<string, string[]>();
  /** Notable journal events waiting for the #agent-terminal stream (posted once per pulse). */
  private readonly termBuffer: string[] = [];
  private readonly sql: SqlLike;
  private readonly d: Doctrine;
  private readonly c: Constitution;

  constructor(private readonly deps: BrainDeps) {
    this.sql = deps.sql;
    this.d = deps.d;
    this.c = deps.c;
    this.journal = new Journal(deps.sql);
    this.journal.onAppend = (r) => {
      const line = terminalLine(r);
      if (!line) return;
      this.termBuffer.push(line);
      if (this.termBuffer.length > 40) this.termBuffer.shift();
    };
    this.budget = new FreeTierBudget(deps.sql, deps.d);
  }

  // ------------------------------------------------------------------ setup

  init(bootInfo: Record<string, unknown>): void {
    const now = this.deps.now();
    for (const account of ACCOUNTS) {
      const cfg = this.d.accounts[account];
      if (!cfg) continue;
      this.sql.exec(
        "INSERT OR IGNORE INTO accounts (account, autonomy_stop, day) VALUES (?, ?, ?)",
        account,
        cfg.autonomy_stop,
        utcDay(now),
      );
    }
    // ADR-024: the approve-each-trade mode (Stop 1) no longer exists. LIVE falls back to dormant (0), PAPER to auto (2).
    this.sql.exec("UPDATE accounts SET autonomy_stop = 0 WHERE account = 'LIVE' AND autonomy_stop IN (1, 2)");
    this.sql.exec(
      "UPDATE accounts SET autonomy_stop = 2 WHERE account = 'PAPER' AND autonomy_stop IN (1, 3)",
    );
    const lastBoot = getKV(this.sql, "boot_hash");
    const bootHash = JSON.stringify(bootInfo);
    if (lastBoot !== bootHash) {
      this.journal.append("SYSTEM", "BOOT", null, bootInfo, now);
      setKV(this.sql, "boot_hash", bootHash, now);
    }
  }

  private account(a: AccountId): AccountRow | null {
    return one<AccountRow>(this.sql, "SELECT * FROM accounts WHERE account = ?", a);
  }

  private effectiveEquityCents(row: AccountRow): number | null {
    if (row.broker_equity_cents === null) return null;
    return row.broker_equity_cents - (row.account === "PAPER" ? row.modeled_cost_cents : 0);
  }

  // ------------------------------------------------------------------ pulse

  async pulse(): Promise<PulseReport> {
    const started = this.deps.now();
    const rowsBefore = { ...this.sql.stats };
    const report: PulseReport = {
      at: started,
      budgetMode: "NORMAL",
      kill: "UNKNOWN",
      accounts: {},
      contracts: 0,
      entries: 0,
      exits: 0,
      flushed: 0,
      newsQueued: 0,
      triaged: 0,
      promoted: 0,
      tier2: 0,
      courtContracts: 0,
      nextPulseSeconds: this.d.cadence.pulse_seconds_flat,
    };
    this.budget.add("do_requests", 1, started);
    this.rollDay(started);

    report.kill = await this.readKill();
    if (report.kill !== "UNKNOWN") this.noteKill(report.kill === "KILLED");
    const budget = this.budget.snapshot(started);
    report.budgetMode = budget.mode;

    // 1. Sync every configured account with the broker (broker = truth).
    for (const account of ACCOUNTS) {
      const broker = this.deps.brokers[account];
      if (!broker) continue;
      try {
        await this.syncAccount(account, broker);
        const row = this.account(account);
        report.accounts[account] = {
          ok: true,
          positions: this.positions(account).length,
          ...(row ? { band: row.breaker } : {}),
        };
      } catch (e) {
        const msg = errText(e);
        this.sql.exec("UPDATE accounts SET last_error = ? WHERE account = ?", msg.slice(0, 500), account);
        report.accounts[account] = { ok: false, error: msg };
        await this.alertOnce(`sync:${account}`, `⚠️ ${account} broker sync failed: ${msg.slice(0, 300)}`);
      }
    }

    // 2. Exits first: quotes → synthetic stops, targets, time stops; then protective broker stops.
    const quotes = await this.quotesFor(this.symbolsInPlay()).catch(() => ({}) as Record<string, Quote>);
    for (const account of ACCOUNTS) {
      const broker = this.deps.brokers[account];
      if (!broker || report.accounts[account]?.ok !== true) continue;
      try {
        report.exits += await this.manageExits(account, broker, quotes);
        await this.manageOrders(account, broker);
        await this.ensureProtectiveStops(account, broker);
        await this.applyBreaker(account, broker);
        if (report.kill === "KILLED") await this.cancelEntries(account, broker, "KILLED by sentinel");
      } catch (e) {
        if (!(e instanceof SubrequestBudgetExceeded)) {
          await this.alertOnce(
            `manage:${account}`,
            `⚠️ ${account} order management error: ${errText(e).slice(0, 300)}`,
          );
        }
      }
    }

    // 2b. World intake (Phase 2): headlines into the triage queue for Phase 3. Never blocks trading.
    try {
      report.newsQueued = await this.intakeNews();
    } catch (e) {
      if (!(e instanceof SubrequestBudgetExceeded)) {
        await this.alertOnce("news-intake", `⚠️ news intake failed: ${errText(e).slice(0, 200)}`);
      }
    }

    // 2c. Tier 1 triage (Phase 3): one batched clef-flash call over the queue. Never blocks trading.
    try {
      for (let i = 0; i < this.d.funnel.tier1.max_batches_per_pulse; i++) {
        const t = await this.triageTier1();
        report.triaged += t.triaged;
        report.promoted += t.promoted;
        if (t.triaged === 0) break;
      }
    } catch (e) {
      if (!(e instanceof SubrequestBudgetExceeded)) {
        await this.alertOnce("triage-t1", `⚠️ Tier 1 triage failed: ${errText(e).slice(0, 200)}`);
      }
    }

    // 2d. Tier 2 (Clef 27B) on one promoted candidate per pulse. Never blocks trading.
    try {
      report.tier2 = await this.triageTier2();
    } catch (e) {
      if (!(e instanceof SubrequestBudgetExceeded)) {
        await this.alertOnce("triage-t2", `⚠️ Tier 2 failed: ${errText(e).slice(0, 200)}`);
      }
    }

    // 2e. Court (Tier 3): one sprint per pulse, only when new entries are possible at all.
    if (report.kill === "CLEAR" && budget.mode !== "REDUCE_ONLY") {
      try {
        report.courtContracts = await this.runCourt();
      } catch (e) {
        if (!(e instanceof SubrequestBudgetExceeded)) {
          await this.alertOnce("court", `⚠️ court failed: ${errText(e).slice(0, 200)}`);
        }
      }
    }

    // 3. New entries (never when killed/unknown or budget is in REDUCE_ONLY).
    if (report.kill === "CLEAR" && budget.mode !== "REDUCE_ONLY") {
      try {
        for (const run of [
          () => this.runBaseline(quotes),
          () => this.runBounce(quotes),
          () => this.runInverse(),
          () => this.runKronos(quotes),
          () => this.runTrend(quotes),
          () => this.runTom(quotes),
          () => this.runRsi2(),
        ]) {
          const r = await run();
          report.contracts += r.contracts;
          report.entries += r.entries;
        }
      } catch (e) {
        if (!(e instanceof SubrequestBudgetExceeded)) {
          await this.alertOnce("strategy", `⚠️ strategy step failed: ${errText(e).slice(0, 300)}`);
        }
      }
    }

    await this.checkBatchStaleness(started).catch(() => undefined);
    await this.dispatchDue(started).catch(() => undefined);

    // 4. Persist, report, schedule.
    this.sampleEquity(started);
    report.flushed = await this.flushJournal();
    await this.updateHud().catch(() => undefined);
    await this.flushTerminal().catch(() => undefined);
    // Heartbeat stats for the day (reported in DAY_ROLL; the Governor's LIVE-gate heartbeat criterion).
    const prevPulse = Number(getKV(this.sql, "last_pulse_at") ?? 0);
    const gapS = prevPulse > 0 ? Math.round((started - prevPulse) / 1000) : 0;
    setKV(this.sql, "day_pulses", String(Number(getKV(this.sql, "day_pulses") ?? 0) + 1), started);
    setKV(
      this.sql,
      "day_max_gap_s",
      String(Math.max(Number(getKV(this.sql, "day_max_gap_s") ?? 0), gapS)),
      started,
    );
    setKV(this.sql, "last_pulse_at", String(started), started);
    const exposed = ACCOUNTS.some((a) => this.positions(a).length > 0 || this.openOrders(a).length > 0);
    report.nextPulseSeconds = exposed
      ? this.d.cadence.pulse_seconds_exposed
      : budget.mode === "THRIFT"
        ? this.d.cadence.pulse_seconds_thrift
        : this.d.cadence.pulse_seconds_flat;

    const ended = this.deps.now();
    this.budget.add("do_duration_gb_s", ((ended - started) / 1000) * DO_MEMORY_GB, ended);
    this.budget.add("do_rows_written", this.sql.stats.rowsWritten - rowsBefore.rowsWritten, ended);
    this.budget.add("do_rows_read", this.sql.stats.rowsRead - rowsBefore.rowsRead, ended);
    return report;
  }

  /** Start any batch workflow whose slot came due in the last 20 min (ADR-032). Never blocks trading. */
  private async dispatchDue(now: number): Promise<number> {
    const dispatcher = this.deps.dispatcher;
    if (!dispatcher) return 0;
    let last: Record<string, number> = {};
    try {
      last = JSON.parse(getKV(this.sql, "dispatch_last") ?? "{}") as Record<string, number>;
    } catch {
      last = {};
    }
    let n = 0;
    for (const { job, slot } of dueJobs(now, last)) {
      try {
        await dispatcher.dispatch(job.workflow, job.inputs);
        last[job.key] = slot;
        setKV(this.sql, "dispatch_last", JSON.stringify(last), now);
        this.journal.append("SYSTEM", "DISPATCH", null, { job: job.key, workflow: job.workflow, slot }, now);
        n++;
      } catch (e) {
        if (e instanceof SubrequestBudgetExceeded) break;
        await this.alertOnce("dispatch", `⚠️ batch dispatch failed (${job.key}): ${errText(e).slice(0, 200)}`);
      }
    }
    return n;
  }

  private async readKill(): Promise<KillState> {
    try {
      return (await this.deps.readKillFlag()) ? "KILLED" : "CLEAR";
    } catch {
      return "UNKNOWN";
    }
  }

  private rollDay(now: number): void {
    const day = utcDay(now);
    for (const row of this.sql.exec<AccountRow>("SELECT * FROM accounts")) {
      if (row.day === day) continue;
      const eq = this.effectiveEquityCents(row);
      this.sql.exec(
        "UPDATE accounts SET day = ?, orders_today = 0, day_start_equity_cents = ? WHERE account = ?",
        day,
        eq,
        row.account,
      );
    }
    if (getKV(this.sql, "anchor_day") !== day) {
      const head = this.journal.head();
      const pulses = Number(getKV(this.sql, "day_pulses") ?? 0);
      const maxGap = Number(getKV(this.sql, "day_max_gap_s") ?? 0);
      const equity = Object.fromEntries(
        this.sql
          .exec<AccountRow>("SELECT * FROM accounts")
          .map((r) => [r.account, this.effectiveEquityCents(r)] as const),
      );
      // pulses / max_gap_s describe the day that just ended (null on the very first roll).
      const prev = getKV(this.sql, "anchor_day");
      this.journal.append(
        "SYSTEM",
        "DAY_ROLL",
        null,
        {
          day,
          head,
          prev_day: prev,
          pulses: prev ? pulses : null,
          max_gap_s: prev ? maxGap : null,
          equity_cents: equity,
        },
        now,
      );
      setKV(this.sql, "day_pulses", "0", now);
      setKV(this.sql, "day_max_gap_s", "0", now);
      setKV(this.sql, "anchor_day", day, now);
      // External anchor for the hash chain (U7). Fire-and-forget; failure is retried tomorrow by design.
      void this.deps.notifier.post("briefs", {
        content: `🔗 Journal anchor ${day}: seq ${head.seq} · \`${head.sha}\``,
      });
      this.sql.exec("DELETE FROM seen_activities WHERE at < ?", now - 7 * 86_400_000);
      this.sql.exec("DELETE FROM seen_items WHERE at < ?", now - 3 * 86_400_000);
      this.budget.prune(now);
      this.sql.exec("DELETE FROM equity_history WHERE at < ?", now - 35 * 86_400_000);
    }
  }

  // ------------------------------------------------------------------ broker sync / reconcile

  private async syncAccount(account: AccountId, broker: BrokerApi): Promise<void> {
    const now = this.deps.now();
    const cursor =
      one<{ value: string }>(this.sql, "SELECT value FROM cursors WHERE name = ?", `activities:${account}`)
        ?.value ?? null;
    const [acct, positions, openOrders, activities] = await Promise.all([
      broker.account(),
      broker.positions(),
      broker.openOrders(),
      broker.activities(cursor),
    ]);
    if (acct.trading_blocked || acct.account_blocked)
      throw new Error(`account blocked at broker (${acct.status})`);
    // Conditions that block entries are re-checked every sync; when they all clear, so does the mode (ADR-025).
    const issues: string[] = [];
    if (acct.multiplier !== undefined && acct.multiplier !== null && Number(acct.multiplier) > 1) {
      // Constitution U3: cash only. A margin multiplier means the broker would let us borrow; we never do.
      issues.push("broker reports a margin multiplier > 1; cash-only doctrine");
    }

    // Adopt our own orders the DO lost track of (crash between submit and record).
    const known = new Set(
      this.sql
        .exec<{ c: string }>("SELECT client_order_id AS c FROM orders WHERE account = ?", account)
        .map((r) => r.c),
    );
    for (const o of openOrders) {
      if (known.has(o.client_order_id)) continue;
      if (o.client_order_id.startsWith(`c54-${account[0]}-`))
        this.adoptOrder(account, o.client_order_id, o, now);
      else {
        issues.push(`unknown open order ${o.client_order_id} at broker`);
        await this.alertOnce(
          `orphan-order:${o.id}`,
          `🧩 ${account}: unknown open order ${o.symbol} ${o.side} (${o.client_order_id}). Entries blocked.`,
        );
      }
    }

    // Fills and fees, oldest first.
    let lastTs = cursor;
    // First sync of an account: history before CORTEX existed isn't ours. Start the cursor now instead of
    // replaying (and alerting on) every past fill.
    const backlog = cursor === null ? activities : [];
    if (cursor === null) {
      lastTs = new Date(now).toISOString();
      this.journal.append(account, "ACTIVITY_BASELINE", null, { skipped_history: backlog.length }, now);
    }
    for (const act of cursor === null ? [] : activities) {
      lastTs = act.transaction_time ?? act.date ?? lastTs;
      const seen = one(this.sql, "SELECT id FROM seen_activities WHERE id = ?", act.id);
      if (seen) continue;
      this.sql.exec("INSERT INTO seen_activities (id, account, at) VALUES (?, ?, ?)", act.id, account, now);
      if (act.activity_type === "FILL") this.applyFill(account, act, now);
      else if (act.activity_type === "CFEE")
        this.journal.append(account, "FEE", act.symbol ?? null, act, now);
    }
    if (lastTs) {
      this.sql.exec(
        "INSERT INTO cursors (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        `activities:${account}`,
        lastTs,
        now,
      );
    }

    // Orders we think are open but the broker doesn't list: fetch final status (bounded per pulse).
    const brokerOpen = new Set(openOrders.map((o) => o.client_order_id));
    const missing = this.openOrders(account)
      .filter((o) => o.state !== "PLANNED" && !brokerOpen.has(o.client_order_id))
      .slice(0, 5);
    for (const o of missing) {
      const final = await broker.orderByClientId(o.client_order_id);
      const state = final?.status ?? "unknown";
      this.sql.exec(
        "UPDATE orders SET state = ?, broker_order_id = COALESCE(broker_order_id, ?), filled_qty = ?, avg_fill_price = ?, updated_at = ? WHERE client_order_id = ?",
        state,
        final?.id ?? null,
        final?.filled_qty ?? o.filled_qty,
        final?.filled_avg_price ?? o.avg_fill_price,
        now,
        o.client_order_id,
      );
      this.logOrder(account, o, `FINAL_${state.toUpperCase()}`, now);
    }
    for (const o of openOrders) {
      this.sql.exec(
        "UPDATE orders SET state = ?, filled_qty = ?, avg_fill_price = ?, updated_at = ? WHERE client_order_id = ?",
        o.status,
        o.filled_qty,
        o.filled_avg_price ?? null,
        now,
        o.client_order_id,
      );
    }

    // Positions: broker is truth for quantity; we own stops/targets.
    const brokerPos = new Map(positions.map((p) => [canonicalSymbol(p.symbol, p.asset_class), p]));
    for (const local of this.positions(account)) {
      const bp = brokerPos.get(local.symbol);
      if (!bp) {
        this.closePositionRecord(account, local, local.exit_reason ?? "CLOSED_AT_BROKER", now);
        continue;
      }
      if (Math.abs(Number(bp.qty) - Number(local.qty)) > 1e-12) {
        this.sql.exec(
          "UPDATE positions SET qty = ?, avg_entry = ? WHERE account = ? AND symbol = ?",
          bp.qty,
          bp.avg_entry_price,
          account,
          local.symbol,
        );
        this.journal.append(
          account,
          "QTY_SYNC",
          local.contract_id,
          { symbol: local.symbol, local: local.qty, broker: bp.qty },
          now,
        );
      }
    }
    const localSymbols = new Set(this.positions(account).map((p) => p.symbol));
    for (const [symbol, bp] of brokerPos) {
      if (localSymbols.has(symbol)) continue;
      issues.push(`orphan position ${symbol} at broker`);
      await this.alertOnce(
        `orphan-pos:${account}:${symbol}`,
        `🧩 ${account}: broker holds ${bp.qty} ${symbol} that CORTEX didn't open. Entries blocked until it's gone (close it in Alpaca or /flatten); CORTEX resumes by itself.`,
      );
    }

    // Equity, cash, high-water mark.
    const brokerEq = toCents(dec(acct.equity, "equity"));
    const row = this.account(account);
    const modeled = row?.modeled_cost_cents ?? 0;
    const eff = brokerEq - (account === "PAPER" ? modeled : 0);
    const hwm = Math.max(row?.hwm_cents ?? eff, eff);
    const start = this.d.accounts[account]?.starting_equity_usd;
    if ((row?.hwm_cents ?? null) === null && start !== undefined && eff > start * 2 * 100) {
      // First sight of this account and it's far bigger than doctrine expects (e.g. a paper account still at
      // the $100k default). Sizing would be meaningless for the $54 doctrine, so fail closed (U6).
      this.setMode(
        account,
        "REDUCE_ONLY",
        `equity $${(eff / 100).toFixed(2)} ≫ doctrine start $${start}; reset the account or update doctrine, then /resume`,
        now,
      );
    }
    this.sql.exec(
      `UPDATE accounts SET broker_equity_cents = ?, cash_cents = ?, buying_power_cents = ?, hwm_cents = ?,
         day_start_equity_cents = COALESCE(day_start_equity_cents, ?), reconciled_at = ?, last_error = NULL WHERE account = ?`,
      brokerEq,
      toCents(dec(acct.cash, "cash")),
      toCents(dec(acct.non_marginable_buying_power ?? acct.buying_power, "buying_power")),
      hwm,
      eff,
      now,
      account,
    );
    this.sql.exec("DELETE FROM unsettled WHERE settles_at <= ?", now);

    const after = this.account(account);
    if (issues.length > 0) this.setMode(account, "REDUCE_ONLY", `auto: ${issues.join("; ")}`, now);
    else if (after?.mode === "REDUCE_ONLY" && after.mode_reason?.startsWith("auto:")) {
      this.setMode(account, "NORMAL", "auto: conditions cleared", now);
    }
  }

  private adoptOrder(
    account: AccountId,
    coid: string,
    o: {
      id: string;
      status: string;
      side: "buy" | "sell";
      symbol: string;
      asset_class?: string | undefined;
      qty?: string | null | undefined;
      limit_price?: string | null | undefined;
      stop_price?: string | null | undefined;
      filled_qty: string;
      time_in_force: string;
      type?: string | undefined;
      order_type?: string | undefined;
    },
    now: number,
  ): void {
    const parts = coid.split("-"); // c54-P-xxxxxxxx-E-1
    const short = parts[2] ?? "";
    const contract = this.sql
      .exec<{ contract_id: string }>("SELECT contract_id FROM contracts")
      .find((r) => r.contract_id.replace(/-/g, "").endsWith(short));
    const role: OrderRole = parts[3] === "S" ? "STOP" : parts[3] === "X" ? "EXIT" : "ENTRY";
    const symbol = canonicalSymbol(o.symbol, o.asset_class);
    const reservation = contract
      ? one<{ risk_cents: number; notional_cents: number }>(
          this.sql,
          "SELECT risk_cents, notional_cents FROM risk_reservations WHERE contract_id = ? AND account = ?",
          contract.contract_id,
          account,
        )
      : null;
    this.sql.exec(
      `INSERT OR IGNORE INTO orders (client_order_id, account, contract_id, role, attempt, broker_order_id, state, side, symbol, arena,
         order_type, tif, qty, limit_price, stop_price, filled_qty, risk_cents, notional_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      coid,
      account,
      contract?.contract_id ?? `ADOPTED-${short}`,
      role,
      Number(parts[4] ?? 1),
      o.id,
      o.status,
      o.side,
      symbol,
      isCryptoSymbol(symbol) ? "CRYPTO" : "EQUITIES",
      o.type ?? o.order_type ?? "limit",
      o.time_in_force,
      o.qty ?? "0",
      o.limit_price ?? null,
      o.stop_price ?? null,
      o.filled_qty,
      reservation?.risk_cents ?? 0,
      reservation?.notional_cents ?? 0,
      now,
      now,
    );
    if (contract)
      this.sql.exec(
        "DELETE FROM risk_reservations WHERE contract_id = ? AND account = ?",
        contract.contract_id,
        account,
      );
    this.journal.append(account, "ORDER_ADOPTED", coid, { broker_order_id: o.id, status: o.status }, now);
  }

  private applyFill(
    account: AccountId,
    act: {
      id: string;
      order_id?: string | undefined;
      price?: string | null | undefined;
      qty?: string | null | undefined;
      side?: string | undefined;
      symbol?: string | undefined;
      transaction_time?: string | undefined;
    },
    now: number,
  ): void {
    const order = act.order_id
      ? one<OrderRow>(this.sql, "SELECT * FROM orders WHERE broker_order_id = ?", act.order_id)
      : null;
    const qty = dec(act.qty, "fill.qty");
    const price = dec(act.price, "fill.price");
    const ts = act.transaction_time ? Date.parse(act.transaction_time) : now;
    if (!order) {
      this.journal.append(account, "UNKNOWN_FILL", act.order_id ?? null, act, now);
      void this.alertOnce(
        `unknown-fill:${act.id}`,
        `🧩 ${account}: fill for an order CORTEX didn't place (${act.symbol} ${act.side} ${act.qty}).`,
      );
      return;
    }
    const notional = qty * price;
    const liquidity = order.role === "ENTRY" ? "maker" : "taker";
    let feeCents = 0;
    let slipBps = 0;
    if (account === "PAPER" && this.d.accounts.PAPER?.apply_fee_model) {
      const m = modeledPaperCostCents(order.arena, order.side, liquidity, notional, this.d);
      feeCents = m.feeCents;
      slipBps = m.slippageBps;
      this.sql.exec(
        "UPDATE accounts SET modeled_cost_cents = modeled_cost_cents + ? WHERE account = ?",
        m.feeCents + m.slippageCents,
        account,
      );
    }
    this.journal.enqueue(
      "fills",
      {
        ts,
        account,
        contract_id: order.contract_id,
        client_order_id: order.client_order_id,
        broker_activity_id: act.id,
        symbol: order.symbol,
        side: order.side,
        qty: String(qty),
        price: String(price),
        fee_cents: feeCents,
        modeled_slippage_bps: slipBps,
        expected_price: order.limit_price ?? order.stop_price,
      },
      now,
    );
    this.journal.append(
      account,
      "FILL",
      order.client_order_id,
      { symbol: order.symbol, side: order.side, qty, price, role: order.role, fee_cents: feeCents },
      now,
    );

    const prevFilled = Number(order.filled_qty);
    const prevAvg = order.avg_fill_price ? Number(order.avg_fill_price) : 0;
    const cum = prevFilled + qty;
    const avg = cum > 0 ? (prevFilled * prevAvg + qty * price) / cum : price;
    this.sql.exec(
      "UPDATE orders SET filled_qty = ?, avg_fill_price = ?, updated_at = ? WHERE client_order_id = ?",
      String(cum),
      String(avg),
      now,
      order.client_order_id,
    );

    if (order.role === "ENTRY") {
      const contract = this.contract(order.contract_id);
      const existing = one<PositionRow>(
        this.sql,
        "SELECT * FROM positions WHERE account = ? AND symbol = ?",
        account,
        order.symbol,
      );
      if (existing) {
        const q0 = Number(existing.qty);
        const newQty = q0 + qty;
        const newAvg = (q0 * Number(existing.avg_entry) + qty * price) / newQty;
        this.sql.exec(
          "UPDATE positions SET qty = ?, avg_entry = ? WHERE account = ? AND symbol = ?",
          String(newQty),
          String(newAvg),
          account,
          order.symbol,
        );
      } else {
        const stop = contract?.invalidation_criteria.stop_price ?? String(price * 0.9);
        const target = contract?.entry_plan.targets[0] ?? String(price * 1.1);
        const holdH = contract?.invalidation_criteria.max_hold_hours ?? 72;
        this.sql.exec(
          `INSERT INTO positions (account, symbol, arena, contract_id, qty, avg_entry, stop_price, target_price, fee_rt, opened_at, max_hold_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          account,
          order.symbol,
          order.arena,
          order.contract_id,
          String(qty),
          String(price),
          stop,
          target,
          roundTripFeeRate(order.arena, notional, this.d),
          ts,
          ts + holdH * 3_600_000,
        );
        void this.deps.notifier.post("executions", {
          embeds: [
            {
              title: `🟢 ${account} entry filled · ${order.symbol}`,
              color: COLORS.green,
              description: `${qty} @ ${price} · stop ${stop} · target ${target}`,
            },
          ],
        });
      }
    } else {
      // Sell fills (STOP or EXIT) reduce the position; settlement for equities is tracked T+1 (+1 day buffer).
      if (order.arena === "EQUITIES") {
        this.sql.exec(
          "INSERT INTO unsettled (account, amount_cents, settles_at) VALUES (?, ?, ?)",
          account,
          toCents(notional),
          addBusinessDays(ts, 2),
        );
      }
      const pos = one<PositionRow>(
        this.sql,
        "SELECT * FROM positions WHERE account = ? AND symbol = ?",
        account,
        order.symbol,
      );
      if (pos) {
        const left = Number(pos.qty) - qty;
        const pnlCents = toCents((price - Number(pos.avg_entry)) * qty) - feeCents;
        if (left <= 1e-12) {
          this.closePositionRecord(
            account,
            pos,
            order.role === "STOP" ? "STOP_BROKER" : (pos.exit_reason ?? "EXIT"),
            now,
            pnlCents,
          );
        } else {
          this.sql.exec(
            "UPDATE positions SET qty = ? WHERE account = ? AND symbol = ?",
            String(left),
            account,
            order.symbol,
          );
        }
      }
    }
  }

  private closePositionRecord(
    account: AccountId,
    pos: PositionRow,
    reason: string,
    now: number,
    pnlCents: number | null = null,
  ): void {
    this.sql.exec("DELETE FROM positions WHERE account = ? AND symbol = ?", account, pos.symbol);
    this.sql.exec(
      "INSERT INTO exits (account, symbol, contract_id, reason, pnl_cents, at) VALUES (?, ?, ?, ?, ?, ?)",
      account,
      pos.symbol,
      pos.contract_id,
      reason,
      pnlCents,
      now,
    );
    this.journal.append(
      account,
      "EXIT",
      pos.contract_id,
      { symbol: pos.symbol, reason, pnl_cents: pnlCents },
      now,
    );
    void this.deps.notifier.post("executions", {
      embeds: [
        {
          title: `${pnlCents !== null && pnlCents >= 0 ? "✅" : "🔻"} ${account} closed · ${pos.symbol}`,
          color: pnlCents !== null && pnlCents >= 0 ? COLORS.green : COLORS.red,
          description: `reason ${reason}${pnlCents !== null ? ` · P&L $${(pnlCents / 100).toFixed(2)}` : ""}`,
        },
      ],
    });
  }

  // ------------------------------------------------------------------ exits & stops

  private async manageExits(
    account: AccountId,
    broker: BrokerApi,
    quotes: Record<string, Quote>,
  ): Promise<number> {
    const now = this.deps.now();
    let exits = 0;
    for (const pos of this.positions(account)) {
      const q = quotes[pos.symbol];
      let reason: string | null = pos.state === "EXITING" ? (pos.exit_reason ?? "EXIT") : null;
      if (!reason && q && now - q.at <= this.d.staleness.quote_seconds * 1000) {
        if (q.bid <= Number(pos.stop_price)) reason = "STOP_SYNTHETIC";
        else if (q.bid >= Number(pos.target_price)) reason = "TARGET";
      }
      if (!reason && now >= pos.max_hold_until) reason = "TIME_STOP";
      if (!reason) continue;
      if (await this.exitPosition(account, broker, pos, reason, q ?? null)) exits++;
    }
    return exits;
  }

  /** Cancel the protective stop, then sell with a marketable limit inside a price collar. Retried each pulse. */
  private async exitPosition(
    account: AccountId,
    broker: BrokerApi,
    pos: PositionRow,
    reason: string,
    q: Quote | null,
  ): Promise<boolean> {
    const now = this.deps.now();
    if (pos.state !== "EXITING") {
      this.sql.exec(
        "UPDATE positions SET state = 'EXITING', exit_reason = ? WHERE account = ? AND symbol = ?",
        reason,
        account,
        pos.symbol,
      );
      this.journal.append(account, "EXIT_START", pos.contract_id, { symbol: pos.symbol, reason }, now);
    }
    const openExit = this.openOrders(account).find((o) => o.symbol === pos.symbol && o.role === "EXIT");
    if (openExit) return false;
    for (const o of this.openOrders(account).filter((x) => x.symbol === pos.symbol && x.role !== "EXIT")) {
      if (o.broker_order_id) await broker.cancelOrder(o.broker_order_id);
      this.sql.exec(
        "UPDATE orders SET state = 'pending_cancel', updated_at = ? WHERE client_order_id = ?",
        now,
        o.client_order_id,
      );
    }
    if (!q) return false; // no fresh price → retry next pulse; the broker stop/sentinel still protect
    const crypto = pos.arena === "CRYPTO";
    const regularHours = crypto ? true : (await broker.clock()).is_open;
    if (!crypto && !regularHours && !this.inExtendedSession(now)) return false;
    const tick = defaultTick(q.bid, pos.arena);
    const limit = roundPrice(q.bid * (1 - this.d.execution.exit_collar_bps / 10_000), tick, "down");
    const attempt =
      1 +
      (one<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM orders WHERE contract_id = ? AND account = ? AND role = 'EXIT'",
        pos.contract_id,
        account,
      )?.n ?? 0);
    const placed = await this.submit(account, broker, {
      contractId: pos.contract_id,
      role: "EXIT",
      attempt,
      side: "sell",
      symbol: pos.symbol,
      arena: pos.arena,
      type: "limit",
      tif: crypto ? "ioc" : "day",
      qty: pos.qty,
      limitPrice: limit,
      stopPrice: null,
      riskCents: 0,
      notionalCents: toCents(Number(pos.qty) * q.bid),
      extendedHours: !regularHours,
    });
    return placed;
  }

  private inExtendedSession(now: number): boolean {
    // Alpaca extended hours (ET): 04:00–09:30 and 16:00–20:00, weekdays. Approximated in UTC with a DST-safe
    // check via Intl; only used for equity exits outside regular hours.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (["Sat", "Sun"].includes(get("weekday"))) return false;
    const mins = Number(get("hour")) * 60 + Number(get("minute"));
    return (mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200);
  }

  /** Every position gets a broker-side stop where Alpaca accepts one (U4). */
  private async ensureProtectiveStops(account: AccountId, broker: BrokerApi): Promise<void> {
    for (const pos of this.positions(account)) {
      if (pos.state !== "OPEN") continue;
      const live = pos.broker_stop_coid
        ? one<OrderRow>(
            this.sql,
            `SELECT * FROM orders WHERE client_order_id = ? AND state IN (${OPEN_SQL})`,
            pos.broker_stop_coid,
          )
        : null;
      if (live) continue;
      if (this.openOrders(account).some((o) => o.symbol === pos.symbol && o.role === "ENTRY")) continue; // wait for entry to finish
      const crypto = pos.arena === "CRYPTO";
      if (!crypto && !(await broker.clock()).is_open) continue; // equity fractional stops: regular hours, TIF day
      const stop = Number(pos.stop_price);
      const tick = defaultTick(stop, pos.arena);
      const attempt =
        1 +
        (one<{ n: number }>(
          this.sql,
          "SELECT COUNT(*) AS n FROM orders WHERE contract_id = ? AND account = ? AND role = 'STOP'",
          pos.contract_id,
          account,
        )?.n ?? 0);
      const coid = clientOrderId(account, pos.contract_id, "STOP", attempt);
      const ok = await this.submit(account, broker, {
        contractId: pos.contract_id,
        role: "STOP",
        attempt,
        side: "sell",
        symbol: pos.symbol,
        arena: pos.arena,
        type: crypto ? "stop_limit" : "stop",
        tif: crypto ? "gtc" : "day",
        qty: pos.qty,
        limitPrice: crypto
          ? roundPrice(stop * (1 - this.d.execution.exit_collar_bps / 10_000), tick, "down")
          : null,
        stopPrice: roundPrice(stop, tick, "down"),
        riskCents: 0,
        notionalCents: toCents(Number(pos.qty) * stop),
        extendedHours: false,
      });
      if (ok)
        this.sql.exec(
          "UPDATE positions SET broker_stop_coid = ? WHERE account = ? AND symbol = ?",
          coid,
          account,
          pos.symbol,
        );
    }
  }

  /** Unfilled passive entries are cancelled after N pulses (no chasing). */
  private async manageOrders(account: AccountId, broker: BrokerApi): Promise<void> {
    const now = this.deps.now();
    for (const o of this.openOrders(account).filter((x) => x.role === "ENTRY" && x.state !== "PLANNED")) {
      const pulses = o.pulses_unfilled + 1;
      this.sql.exec(
        "UPDATE orders SET pulses_unfilled = ? WHERE client_order_id = ?",
        pulses,
        o.client_order_id,
      );
      if (
        pulses >= this.d.execution.max_unfilled_pulses &&
        o.broker_order_id &&
        o.state !== "pending_cancel"
      ) {
        await broker.cancelOrder(o.broker_order_id);
        this.sql.exec(
          "UPDATE orders SET state = 'pending_cancel', updated_at = ? WHERE client_order_id = ?",
          now,
          o.client_order_id,
        );
        this.logOrder(account, o, "CANCEL_UNFILLED", now);
      }
    }
    this.sql.exec("DELETE FROM risk_reservations WHERE expires_at < ?", now);
  }

  private async cancelEntries(account: AccountId, broker: BrokerApi, why: string): Promise<void> {
    const now = this.deps.now();
    for (const o of this.openOrders(account).filter((x) => x.role === "ENTRY")) {
      if (o.broker_order_id) await broker.cancelOrder(o.broker_order_id);
      this.sql.exec(
        "UPDATE orders SET state = 'pending_cancel', updated_at = ? WHERE client_order_id = ?",
        now,
        o.client_order_id,
      );
      this.logOrder(account, o, `CANCEL ${why}`, now);
    }
  }

  // ------------------------------------------------------------------ breakers

  private async applyBreaker(account: AccountId, broker: BrokerApi): Promise<void> {
    const now = this.deps.now();
    const row = this.account(account);
    if (!row) return;
    const eq = this.effectiveEquityCents(row);
    if (eq === null || row.hwm_cents === null) return;
    const stopouts =
      one<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM exits WHERE account = ? AND at > ? AND reason IN ('STOP_BROKER','STOP_SYNTHETIC')",
        account,
        now - 86_400_000,
      )?.n ?? 0;
    const state = evaluateBreaker(
      {
        equityCents: eq,
        hwmCents: row.hwm_cents,
        dayStartEquityCents: row.day_start_equity_cents ?? eq,
        stopouts24h: stopouts,
        locked: row.locked === 1,
      },
      this.d,
    );
    const rung = effectiveRung(row.rung, eq / 100, this.d);
    if (state.band !== row.breaker || rung !== row.rung) {
      this.sql.exec("UPDATE accounts SET breaker = ?, rung = ? WHERE account = ?", state.band, rung, account);
      this.journal.append(account, "BREAKER", null, { from: row.breaker, to: state.band, ...state }, now);
      const color =
        state.band === "GREEN"
          ? COLORS.green
          : state.band === "YELLOW"
            ? COLORS.yellow
            : state.band === "ORANGE"
              ? COLORS.orange
              : COLORS.red;
      await this.deps.notifier.post("alarms", {
        embeds: [
          {
            title: `${account} breaker ${row.breaker} → ${state.band}`,
            color,
            description: state.reasons.join("\n") || `drawdown ${(state.drawdown * 100).toFixed(2)}%`,
          },
        ],
      });
    }
    if (state.band === "RED" && row.locked === 0) {
      this.sql.exec("UPDATE accounts SET locked = 1 WHERE account = ?", account);
      setKV(this.sql, `red_locked_at:${account}`, String(now), now);
      this.journal.append(account, "RED_LOCK", null, state, now);
      await this.flatten(account, "RED breaker", broker);
      return;
    }
    if (account === "PAPER" && row.locked === 1) await this.maybeAutoUnlockPaper(now);
  }

  /**
   * PAPER runs fully autonomously (ADR-025): after a RED lock it unlocks itself once the cooldown has passed and the
   * account is flat, writing a machine postmortem. Every RED trip stays in the journal and counts against the LIVE
   * graduation gate. LIVE never auto-unlocks (constitution U5).
   */
  private async maybeAutoUnlockPaper(now: number): Promise<void> {
    const lockedAt = Number(getKV(this.sql, "red_locked_at:PAPER") ?? now);
    const coolMs = this.d.breakers.paper_auto_unlock_hours * 3_600_000;
    if (now - lockedAt < coolMs) return;
    if (this.positions("PAPER").length > 0 || this.openOrders("PAPER").length > 0) return;
    const exits = this.sql.exec<{ reason: string; pnl_cents: number | null }>(
      "SELECT reason, pnl_cents FROM exits WHERE account = 'PAPER' AND at >= ?",
      lockedAt - 86_400_000,
    );
    const pnl = exits.reduce((s, e) => s + (e.pnl_cents ?? 0), 0);
    const reasons = [...new Set(exits.map((e) => e.reason))].join(", ") || "none";
    const postmortem =
      `Automatic PAPER recovery after ${(coolMs / 3_600_000).toFixed(0)}h cooldown. ` +
      `${exits.length} exit(s) in the 24h before the lock and since (reasons: ${reasons}), ` +
      `net $${(pnl / 100).toFixed(2)}. Counted against the LIVE graduation gate.`;
    const msg = this.unlock("PAPER", postmortem, "auto");
    await this.deps.notifier.post("alarms", {
      content: `🔓 ${msg}
${postmortem}`,
    });
  }

  // ------------------------------------------------------------------ entries

  private async runBaseline(quotes: Record<string, Quote>): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = baselineParams(this.d);
    const strategy = this.d.strategies.find((s) => s.id === BASELINE_ID);
    if (!p || !strategy || strategy.status !== "ACTIVE" || !this.deps.market)
      return { contracts: 0, entries: 0 };
    const accounts = strategy.accounts.filter((a) => this.deps.brokers[a]);
    if (accounts.length === 0) return { contracts: 0, entries: 0 };
    const last = Number(getKV(this.sql, "baseline:last_run") ?? 0);
    if (now - last < 3_600_000) return { contracts: 0, entries: 0 }; // hourly
    setKV(this.sql, "baseline:last_run", String(now), now);

    const universe = strategy.universe ?? [];
    const bars = await this.deps.market.cryptoDailyBars(
      [...new Set(["BTC/USD", ...universe])],
      p.lookback_days + p.atr_period + 5,
      now,
    );
    const proxy = regimeProxyRiskOn(bars["BTC/USD"] ?? [], p);
    this.sql.exec(
      "INSERT INTO regime_state (arena, posture, score, ceiling, payload_json, as_of) VALUES ('CRYPTO_PROXY', ?, NULL, NULL, ?, ?) ON CONFLICT(arena) DO UPDATE SET posture = excluded.posture, payload_json = excluded.payload_json, as_of = excluded.as_of",
      proxy?.riskOn ? "NEW_ENTRY_ALLOWED" : "REDUCE_ONLY",
      JSON.stringify({ source: "baseline-proxy", ...proxy }),
      now,
    );
    // Regime gate (Tier 0): the batch crypto composite wins when fresh; the BTC/EMA proxy is the fallback.
    const regime = { riskOn: this.cryptoLongsAllowed(now, proxy?.riskOn ?? false) };
    const missing = universe.filter((s) => !quotes[s]);
    const fresh =
      missing.length > 0 ? { ...quotes, ...(await this.deps.market.cryptoQuotes(missing)) } : quotes;

    let contracts = 0;
    let entries = 0;
    for (const symbol of universe) {
      const dayKey = `baseline:${symbol}:${utcDay(now)}`;
      if (getKV(this.sql, dayKey)) continue;
      const q = fresh[symbol];
      const b = bars[symbol];
      if (!q || !b) continue;
      const asset = await this.assetMeta(symbol, accounts[0] as AccountId);
      const tick = asset?.price_increment ? Number(asset.price_increment) : defaultTick(q.bid, "CRYPTO");
      const { contract } = baselineSignal(
        {
          symbol,
          bars: b,
          bid: q.bid,
          ask: q.ask,
          regimeRiskOn: regime?.riskOn ?? false,
          now,
          contractId: uuidv7(now),
          tick,
        },
        p,
      );
      if (!contract) continue; // "no breakout" is the normal case; not a rejection worth journaling
      setKV(this.sql, dayKey, contract.contract_id, now);
      this.recordContract(contract, now);
      void this.deps.notifier.post("court", contractCard(contract));
      contracts++;
      for (const account of accounts) {
        if (await this.route(account, contract, fresh)) entries++;
      }
    }
    return { contracts, entries };
  }

  /** An ACTIVE rule strategy's runnable accounts, or null when it is off or ran within the last hour. */
  private ruleStrategyDue(id: string, now: number): { universe: string[]; accounts: AccountId[] } | null {
    const s = this.d.strategies.find((x) => x.id === id);
    if (s?.status !== "ACTIVE" || !this.deps.market) return null;
    const accounts = s.accounts.filter((a) => this.deps.brokers[a]);
    if (accounts.length === 0) return null;
    const lastKey = `${id}:last_run`;
    if (now - Number(getKV(this.sql, lastKey) ?? 0) < 3_600_000) return null;
    setKV(this.sql, lastKey, String(now), now);
    return { universe: s.universe ?? [], accounts };
  }

  /** Record, announce and route a rule contract (one per symbol per UTC day). */
  private async emitRule(
    id: string,
    contract: DecisionContract,
    accounts: AccountId[],
    quotes: Record<string, Quote>,
    now: number,
  ): Promise<number> {
    setKV(this.sql, `${id}:${contract.symbol}:${utcDay(now)}`, contract.contract_id, now);
    this.recordContract(contract, now);
    void this.deps.notifier.post("court", contractCard(contract));
    let entries = 0;
    for (const account of accounts) if (await this.route(account, contract, quotes)) entries++;
    return entries;
  }

  /** CRYPTO_OVERSOLD_BOUNCE_V1 (ADR-040): counter-trend reversals, deliberately not gated on risk-on. */
  private async runBounce(quotes: Record<string, Quote>): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = bounceParams(this.d);
    const due = p ? this.ruleStrategyDue(BOUNCE_ID, now) : null;
    const m = this.deps.market;
    if (!p || !due || !m) return { contracts: 0, entries: 0 };
    const bars = await m.cryptoDailyBars(due.universe, p.ema_period + p.atr_period + 10, now);
    const missing = due.universe.filter((s) => !quotes[s]);
    const fresh = missing.length > 0 ? { ...quotes, ...(await m.cryptoQuotes(missing)) } : quotes;
    const reg = this.freshRegime("CRYPTO", now);
    let contracts = 0;
    let entries = 0;
    for (const symbol of due.universe) {
      if (getKV(this.sql, `${BOUNCE_ID}:${symbol}:${utcDay(now)}`)) continue;
      const q = fresh[symbol];
      const b = bars[symbol];
      if (!q || !b) continue;
      const asset = await this.assetMeta(symbol, due.accounts[0] as AccountId);
      const tick = asset?.price_increment ? Number(asset.price_increment) : defaultTick(q.bid, "CRYPTO");
      const { contract } = bounceSignal(
        {
          symbol,
          bars: b,
          bid: q.bid,
          ask: q.ask,
          now,
          contractId: uuidv7(now),
          tick,
          regimeScore: reg?.score ?? null,
        },
        p,
      );
      if (!contract) continue;
      contracts++;
      entries += await this.emitRule(BOUNCE_ID, contract, due.accounts, fresh, now);
    }
    return { contracts, entries };
  }

  /**
   * EQUITY_INVERSE_BREAKOUT_V1 (ADR-040): buy 1x inverse ETFs on a breakout while the regime is bearish. Index hedges
   * need a fresh bearish equity posture; crypto hedges (BITI) need the crypto long gate closed. Regular session only.
   */
  private async runInverse(): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = inverseParams(this.d);
    const s = this.d.strategies.find((x) => x.id === INVERSE_ID);
    const via = s?.accounts.find((a) => this.deps.brokers[a]);
    const m = this.deps.market;
    if (!p || !s || s.status !== "ACTIVE" || !via || !m) return { contracts: 0, entries: 0 };
    // cheap pre-check so the hourly slot is spent inside the session, not on a closed market
    if (now - Number(getKV(this.sql, `${INVERSE_ID}:last_run`) ?? 0) < 3_600_000)
      return { contracts: 0, entries: 0 };
    const clock = await (this.deps.brokers[via] as BrokerApi).clock();
    const minsToClose = (Date.parse(clock.next_close) - now) / 60_000;
    if (!clock.is_open || minsToClose < this.d.execution.no_entry_last_minutes_of_session + 20)
      return { contracts: 0, entries: 0 };
    const due = this.ruleStrategyDue(INVERSE_ID, now);
    if (!due) return { contracts: 0, entries: 0 };
    const eq = this.freshRegime("EQUITIES", now);
    const equityBear = !!eq && p.bear_postures.includes(eq.posture);
    const proxy = one<{ posture: string }>(
      this.sql,
      "SELECT posture FROM regime_state WHERE arena = 'CRYPTO_PROXY'",
    );
    const cryptoBear = !this.cryptoLongsAllowed(now, proxy?.posture === "NEW_ENTRY_ALLOWED");
    const [bars, quotes] = await Promise.all([
      m.stockDailyBars(due.universe, p.lookback_days + p.atr_period + 15, now),
      m.stockQuotes(due.universe),
    ]);
    let contracts = 0;
    let entries = 0;
    for (const symbol of due.universe) {
      if (getKV(this.sql, `${INVERSE_ID}:${symbol}:${utcDay(now)}`)) continue;
      const q = quotes[symbol];
      const b = bars[symbol];
      if (!q || !b) continue;
      const crypto = p.crypto_hedges.includes(symbol);
      const { contract } = inverseSignal(
        {
          symbol,
          bars: b,
          bid: q.bid,
          ask: q.ask,
          now,
          contractId: uuidv7(now),
          tick: defaultTick(q.bid, "EQUITIES"),
          bearish: crypto ? cryptoBear : equityBear,
          gate: crypto ? "crypto long gate closed" : `equity posture ${eq?.posture ?? "stale"}`,
        },
        p,
      );
      if (!contract) continue;
      contracts++;
      entries += await this.emitRule(INVERSE_ID, contract, due.accounts, quotes, now);
    }
    return { contracts, entries };
  }

  /** Store the latest Kronos forecasts (ADR-041). Whole-batch replace; each forecast is validated. */
  private ingestKronos(b: Batch, now: number): { ok: boolean; message: string } {
    const p = kronosParams(this.d);
    const age = p ? p.max_forecast_age_hours : 5;
    if (now - b.produced_at > age * 3_600_000) return { ok: false, message: "kronos batch is stale" };
    const r = KronosPayloadSchema.safeParse(b.items.find((x) => x.skill_id === "kronos-forecast")?.payload);
    if (!r.success) return { ok: false, message: "kronos payload failed the schema" };
    setKV(
      this.sql,
      "kronos:forecasts",
      JSON.stringify({
        produced_at: b.produced_at,
        model: r.data.model,
        horizon_hours: r.data.horizon_hours,
        forecasts: r.data.forecasts,
      }),
      now,
    );
    const best = [...r.data.forecasts].sort((x, y) => y.p_win - x.p_win).slice(0, 3);
    this.journal.append(
      "SYSTEM",
      "KRONOS",
      null,
      {
        model: r.data.model,
        n: r.data.forecasts.length,
        best: best.map((f) => `${f.symbol} ${f.p_win}`),
      },
      now,
    );
    return { ok: true, message: `stored ${r.data.forecasts.length} kronos forecasts` };
  }

  /** The stored Kronos forecast for a symbol while it is fresh, else null. */
  kronosFor(
    symbol: string,
    now: number,
  ): (KronosForecast & { produced_at: number; model: string; horizon_hours: number }) | null {
    const p = kronosParams(this.d);
    if (!p) return null;
    try {
      const v = JSON.parse(getKV(this.sql, "kronos:forecasts") ?? "null") as {
        produced_at: number;
        model: string;
        horizon_hours: number;
        forecasts: KronosForecast[];
      } | null;
      if (!v || now - v.produced_at > p.max_forecast_age_hours * 3_600_000) return null;
      const f = v.forecasts.find((x) => x.symbol === symbol);
      return f ? { ...f, produced_at: v.produced_at, model: v.model, horizon_hours: v.horizon_hours } : null;
    } catch {
      return null;
    }
  }

  private resolvedStrategyOutcomes(strategyId: string): number {
    return (
      one<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM exits e JOIN contracts c ON c.contract_id = e.contract_id WHERE json_extract(c.json, '$.strategy_id') = ?",
        strategyId,
      )?.n ?? 0
    );
  }

  /** CRYPTO_KRONOS_FORECAST_V1 (ADR-041): trade fresh Kronos forecasts; probability calibrated, never a size. */
  private async runKronos(quotes: Record<string, Quote>): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = kronosParams(this.d);
    const m = this.deps.market;
    if (!p || !m || !getKV(this.sql, "kronos:forecasts")) return { contracts: 0, entries: 0 };
    const due = this.ruleStrategyDue(KRONOS_ID, now);
    if (!due) return { contracts: 0, entries: 0 };
    const symbols = due.universe.filter(
      (s) => this.kronosFor(s, now) && !getKV(this.sql, `${KRONOS_ID}:${s}:${utcDay(now)}`),
    );
    if (symbols.length === 0) return { contracts: 0, entries: 0 };
    const bars = await m.cryptoDailyBars(symbols, 40, now);
    const missing = symbols.filter((s) => !quotes[s]);
    const fresh = missing.length > 0 ? { ...quotes, ...(await m.cryptoQuotes(missing)) } : quotes;
    const reg = this.freshRegime("CRYPTO", now);
    const resolved = this.resolvedStrategyOutcomes(KRONOS_ID);
    let contracts = 0;
    let entries = 0;
    for (const symbol of symbols) {
      const f = this.kronosFor(symbol, now);
      const q = fresh[symbol];
      const b = bars[symbol];
      if (!f || !q || !b) continue;
      const asset = await this.assetMeta(symbol, due.accounts[0] as AccountId);
      const tick = asset?.price_increment ? Number(asset.price_increment) : defaultTick(q.bid, "CRYPTO");
      const { contract } = kronosSignal(
        {
          symbol,
          bars: b,
          bid: q.bid,
          ask: q.ask,
          now,
          contractId: uuidv7(now),
          tick,
          forecast: f,
          calibratedWin: calibrate(
            f.p_win,
            resolved,
            this.d,
            this.deps.calibration?.maps["kronos.p_win"] ?? null,
          ),
          regimeScore: reg?.score ?? null,
        },
        p,
      );
      if (!contract) continue;
      contracts++;
      entries += await this.emitRule(KRONOS_ID, contract, due.accounts, fresh, now);
    }
    return { contracts, entries };
  }

  /** CRYPTO_TREND_V1 (ADR-045): time-series momentum; the strongest trends get the slots. */
  private async runTrend(quotes: Record<string, Quote>): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = trendParams(this.d);
    const m = this.deps.market;
    const due = p ? this.ruleStrategyDue(TREND_ID, now) : null;
    if (!p || !m || !due) return { contracts: 0, entries: 0 };
    const bars = await m.cryptoDailyBars(due.universe, Math.max(...p.lookbacks) + 30, now);
    const missing = due.universe.filter((s) => !quotes[s]);
    const fresh = missing.length > 0 ? { ...quotes, ...(await m.cryptoQuotes(missing)) } : quotes;
    const picks: { symbol: string; strength: number; contract: DecisionContract }[] = [];
    for (const symbol of due.universe) {
      if (getKV(this.sql, `${TREND_ID}:${symbol}:${utcDay(now)}`)) continue;
      const q = fresh[symbol];
      const b = bars[symbol];
      if (!q || !b) continue;
      const asset = await this.assetMeta(symbol, due.accounts[0] as AccountId);
      const tick = asset?.price_increment ? Number(asset.price_increment) : defaultTick(q.bid, "CRYPTO");
      const r = trendSignal(
        { symbol, bars: b, bid: q.bid, ask: q.ask, now, contractId: uuidv7(now), tick },
        p,
      );
      if (r.contract) picks.push({ symbol, strength: r.strength ?? 0, contract: r.contract });
    }
    picks.sort((a, b) => b.strength - a.strength);
    let entries = 0;
    for (const x of picks.slice(0, p.max_new_per_run))
      entries += await this.emitRule(TREND_ID, x.contract, due.accounts, fresh, now);
    return { contracts: Math.min(picks.length, p.max_new_per_run), entries };
  }

  /** CRYPTO_TURN_OF_MONTH_V1 (ADR-045): one entry per symbol per month inside the window. */
  private async runTom(quotes: Record<string, Quote>): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = tomParams(this.d);
    const m = this.deps.market;
    const due = p ? this.ruleStrategyDue(TOM_ID, now) : null;
    if (!p || !m || !due) return { contracts: 0, entries: 0 };
    const month = utcDay(now).slice(0, 7);
    const todo = due.universe.filter((s) => !getKV(this.sql, `${TOM_ID}:${s}:month:${month}`));
    if (todo.length === 0) return { contracts: 0, entries: 0 };
    const bars = await m.cryptoDailyBars(todo, 30, now);
    const missing = todo.filter((s) => !quotes[s]);
    const fresh = missing.length > 0 ? { ...quotes, ...(await m.cryptoQuotes(missing)) } : quotes;
    let contracts = 0;
    let entries = 0;
    for (const symbol of todo) {
      const q = fresh[symbol];
      const b = bars[symbol];
      if (!q || !b) continue;
      const tick = defaultTick(q.bid, "CRYPTO");
      const { contract } = tomSignal(
        { symbol, bars: b, bid: q.bid, ask: q.ask, now, contractId: uuidv7(now), tick },
        p,
      );
      if (!contract) continue;
      setKV(this.sql, `${TOM_ID}:${symbol}:month:${month}`, contract.contract_id, now);
      contracts++;
      entries += await this.emitRule(TOM_ID, contract, due.accounts, fresh, now);
    }
    return { contracts, entries };
  }

  /** EQUITY_RSI2_PULLBACK_V1 (ADR-045): regular session only, like the inverse strategy. */
  private async runRsi2(): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    const p = rsi2Params(this.d);
    const s = this.d.strategies.find((x) => x.id === RSI2_ID);
    const via = s?.accounts.find((a) => this.deps.brokers[a]);
    const m = this.deps.market;
    if (!p || !s || s.status !== "ACTIVE" || !via || !m) return { contracts: 0, entries: 0 };
    if (now - Number(getKV(this.sql, `${RSI2_ID}:last_run`) ?? 0) < 3_600_000)
      return { contracts: 0, entries: 0 };
    const clock = await (this.deps.brokers[via] as BrokerApi).clock();
    const minsToClose = (Date.parse(clock.next_close) - now) / 60_000;
    if (!clock.is_open || minsToClose < this.d.execution.no_entry_last_minutes_of_session + 20)
      return { contracts: 0, entries: 0 };
    const due = this.ruleStrategyDue(RSI2_ID, now);
    if (!due) return { contracts: 0, entries: 0 };
    const [bars, quotes] = await Promise.all([
      m.stockDailyBars(due.universe, p.sma_trend + 40, now),
      m.stockQuotes(due.universe),
    ]);
    let contracts = 0;
    let entries = 0;
    for (const symbol of due.universe) {
      if (getKV(this.sql, `${RSI2_ID}:${symbol}:${utcDay(now)}`)) continue;
      const q = quotes[symbol];
      const b = bars[symbol];
      if (!q || !b) continue;
      const { contract } = rsi2Signal(
        {
          symbol,
          bars: b,
          bid: q.bid,
          ask: q.ask,
          now,
          contractId: uuidv7(now),
          tick: defaultTick(q.bid, "EQUITIES"),
        },
        p,
      );
      if (!contract) continue;
      contracts++;
      entries += await this.emitRule(RSI2_ID, contract, due.accounts, quotes, now);
    }
    return { contracts, entries };
  }

  /** Symbols whose news we watch: held positions + all doctrine watchlists, in Alpaca news format (no slash). */
  private newsSymbols(): string[] {
    const s = new Set<string>(this.symbolsInPlay());
    for (const list of Object.values(this.d.watchlists)) for (const x of list) s.add(x);
    return [...s].map((x) => x.replace("/", "")).slice(0, 40);
  }

  /** Pull new headlines into triage_queue (deduped, capped at TRIAGE_QUEUE_MAX). Returns how many were queued. */
  private async intakeNews(): Promise<number> {
    const m = this.deps.market;
    if (!m) return 0;
    const now = this.deps.now();
    const cursor = one<{ value: string }>(this.sql, "SELECT value FROM cursors WHERE name = 'news'")?.value;
    const since = cursor ?? new Date(now - 3_600_000).toISOString();
    const items = await m.news(this.newsSymbols(), since);
    let queued = 0;
    let last = since;
    for (const n of items) {
      // Alpaca's `start` is inclusive: step 1 s past the newest item, and remember ids so a dropped item
      // never comes back (it used to be re-triaged every pulse).
      last = new Date(Math.max(Date.parse(last), n.createdAt + 1000)).toISOString();
      const id = `news:${n.id}`;
      if (!this.markSeen(id, now)) continue;
      this.sql.exec(
        "INSERT INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 1, ?, ?, ?)",
        id,
        n.symbols[0] ?? "",
        JSON.stringify({ kind: "news", ...n }),
        now,
      );
      queued++;
    }
    this.sql.exec(
      "INSERT INTO cursors (name, value, updated_at) VALUES ('news', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      last,
      now,
    );
    this.sql.exec(
      `DELETE FROM triage_queue WHERE candidate_id NOT IN (SELECT candidate_id FROM triage_queue ORDER BY enqueued_at DESC LIMIT ${TRIAGE_QUEUE_MAX})`,
    );
    if (queued > 0) this.journal.append("SYSTEM", "NEWS_INTAKE", null, { queued, since }, now);
    return queued;
  }

  /** True the first time an intake id is seen (then remembered for 3 days). */
  private markSeen(id: string, now: number): boolean {
    if (one(this.sql, "SELECT id FROM seen_items WHERE id = ?", id)) return false;
    this.sql.exec("INSERT INTO seen_items (id, at) VALUES (?, ?)", id, now);
    return true;
  }

  /** Crypto long gate: fresh batch composite ≥ doctrine minimum; otherwise fall back to the BTC/EMA proxy. */
  private cryptoLongsAllowed(now: number, proxyRiskOn: boolean): boolean {
    const batch = this.freshRegime("CRYPTO", now);
    return batch
      ? batch.score !== null && batch.score >= this.d.regime_gates.crypto_composite_min_for_longs
      : proxyRiskOn;
  }

  private bumpDaily(key: string, now: number): number {
    const k = `count:${key}:${utcDay(now)}`;
    const n = Number(getKV(this.sql, k) ?? 0) + 1;
    setKV(this.sql, k, String(n), now);
    return n;
  }

  private daily(key: string, now: number): number {
    return Number(getKV(this.sql, `count:${key}:${utcDay(now)}`) ?? 0);
  }

  /** Rejection of a candidate that never became a contract (shadow ledger, graded later). */
  private rejectCandidate(
    c: { candidateId: string; symbol: string; arena: string; source: string },
    stage: string,
    reasons: string[],
    hypothetical: Record<string, unknown>,
    now: number,
  ): void {
    this.journal.enqueue(
      "rejections",
      {
        ts: now,
        candidate_id: c.candidateId,
        contract_id: null,
        symbol: c.symbol,
        arena: c.arena,
        stage,
        reason_codes: JSON.stringify(reasons.slice(0, 8)),
        hypothetical: JSON.stringify(hypothetical),
        source: c.source,
      },
      now,
    );
    this.journal.append(
      "SYSTEM",
      "CANDIDATE_REJECT",
      c.candidateId,
      { stage, symbol: c.symbol, reasons: reasons.slice(0, 3) },
      now,
    );
  }

  /** Context shared by Tier 2 and the court. */
  private scarRules() {
    return this.deps.scar?.rules ?? [];
  }

  private catalystKey(receipts: readonly { evidence_id: string; metric_value: unknown }[]): string | null {
    const r = receipts.find((x) => x.evidence_id === "catalyst_source");
    return r && typeof r.metric_value === "string" ? r.metric_value : null;
  }

  /**
   * Entry guards from the doctrine (ADR-035): 72 h earnings blackout for equities (fail closed when the calendar
   * is stale) and the correlation guard against positions already held on this account.
   */
  private async entryGuards(
    account: AccountId,
    contract: DecisionContract,
    now: number,
  ): Promise<string | null> {
    if (contract.arena === "EQUITIES") {
      const asOf = Number(getKV(this.sql, "earnings_as_of") ?? 0);
      if (now - asOf > EARNINGS_CALENDAR_MAX_AGE_MS) return "earnings calendar stale (fail closed)";
      const today = utcDay(now);
      const horizon = utcDay(now + this.d.execution.earnings_blackout_hours * 3_600_000);
      const e = one<{ date: string }>(
        this.sql,
        "SELECT date FROM earnings WHERE symbol = ? AND date >= ? AND date <= ?",
        contract.symbol,
        today,
        horizon,
      );
      if (e)
        return `earnings on ${e.date} (inside the ${this.d.execution.earnings_blackout_hours} h blackout)`;
    }
    const held = this.positions(account)
      .map((p) => p.symbol)
      .filter((s) => s !== contract.symbol);
    const m = this.deps.market;
    if (held.length === 0 || !m) return null;
    const g = this.d.sizing.correlation_guard;
    const days = g.lookback_days + 10;
    const all = [contract.symbol, ...held];
    const crypto = all.filter(isCryptoSymbol);
    const stocks = all.filter((s) => !isCryptoSymbol(s));
    const [cb, sb] = await Promise.all([
      crypto.length ? m.cryptoDailyBars(crypto, days, now) : Promise.resolve({} as Record<string, Bar[]>),
      stocks.length ? m.stockDailyBars(stocks, days, now) : Promise.resolve({} as Record<string, Bar[]>),
    ]);
    const bars: Record<string, Bar[]> = { ...cb, ...sb };
    const cand = bars[contract.symbol];
    if (!cand) return null;
    const heldBars = Object.fromEntries(held.filter((h) => bars[h]).map((h) => [h, bars[h] as Bar[]]));
    const hit = correlationVeto(cand, heldBars, g.max_corr, now - g.lookback_days * 86_400_000);
    return hit ? `correlated with ${hit.symbol} (ρ=${hit.corr} > ${g.max_corr})` : null;
  }

  /** What a scar rule can see about an entry (ADR-033). Unknown facts never match a rule. */
  facts(
    arena: string,
    strategyId: string,
    origin: string,
    symbol: string,
    source: string | null,
    now: number,
  ): Facts {
    const reg = arena === "CRYPTO" || arena === "EQUITIES" ? this.freshRegime(arena, now) : null;
    const d = new Date(now);
    return {
      symbol,
      arena,
      strategy_id: strategyId,
      origin,
      posture: reg?.posture ?? null,
      regime_score: reg?.score ?? null,
      utc_hour: d.getUTCHours(),
      utc_dow: d.getUTCDay(),
      catalyst_source: source,
    };
  }

  /** W_rep for a catalyst source; 1 until the Governor has enough signals for it (doctrine). */
  reputationWeight(source: string | null): number {
    if (!source) return 1;
    try {
      const map = JSON.parse(getKV(this.sql, "reputation") ?? "{}") as Record<
        string,
        { weight: number; signals: number }
      >;
      const r = map[source];
      if (!r || r.signals < this.d.sizing.reputation_weight.min_signals_before_adjusting) return 1;
      return r.weight;
    } catch {
      return 1;
    }
  }

  /** Scar lessons + up to 3 beliefs about the symbol/arena whose decayed confidence is ≥ 0.35. */
  private memoryFor(symbol: string, arena: string, now: number): { lessons: string[]; beliefs: string[] } {
    const rows = this.sql.exec<{
      statement: string;
      c0: number;
      half_life_days: number;
      validated_at: number;
    }>(
      "SELECT statement, c0, half_life_days, validated_at FROM beliefs WHERE subject IN (?, ?) AND status != 'ARCHIVED'",
      symbol,
      arena,
    );
    const beliefs = rows
      .map((b) => ({
        s: b.statement,
        c: b.c0 * 0.5 ** ((now - b.validated_at) / 86_400_000 / b.half_life_days),
      }))
      .filter((b) => b.c >= 0.35)
      .sort((a, b) => b.c - a.c)
      .slice(0, 3)
      .map((b) => `${b.s} (confidence ${b.c.toFixed(2)})`);
    return { lessons: scarLessons(this.scarRules(), arena, utcDay(now)).slice(0, 5), beliefs };
  }

  private regimeContext(now: number): Record<string, unknown> {
    const c = this.freshRegime("CRYPTO", now);
    const e = this.freshRegime("EQUITIES", now);
    return {
      crypto: c ? { posture: c.posture, score: c.score } : "stale/unknown",
      equities: e ? { posture: e.posture, score: e.score, ceiling: e.ceiling } : "stale/unknown",
    };
  }

  private worldContext(now: number): Record<string, unknown> | null {
    const w = one<{ payload_json: string; as_of: number }>(
      this.sql,
      "SELECT payload_json, as_of FROM regime_state WHERE arena = 'WORLD'",
    );
    if (!w || now - w.as_of > 6 * 3_600_000) return null;
    const p = JSON.parse(w.payload_json) as { groups?: unknown; tone?: unknown };
    return { groups: p.groups ?? null, tone: p.tone ?? null };
  }

  /**
   * Regime gate with the exception lane (ADR-039). Open when the arena's regime allows longs. When it doesn't,
   * an exceptional catalyst (Tier 1 material/priority at the lane's bar) may still proceed, flagged, if the
   * posture is a lane posture (never CASH_PRIORITY), the crypto score is above the floor, the regime data is
   * fresh (stale fails closed, U6), and no other exception position is open.
   */
  private regimeGate(
    arena: string,
    t1: { material: number; escalate: number } | null,
    now: number,
  ): { open: true; exception: boolean } | { open: false; reason: string } {
    const lane = this.d.regime_gates.exception_lane;
    const exceptional = () =>
      lane.enabled &&
      t1 !== null &&
      t1.material >= lane.min_tier1_material &&
      t1.escalate >= lane.min_tier1_escalate &&
      this.openExceptions() < lane.max_concurrent;
    if (arena === "CRYPTO") {
      if (this.cryptoLongsAllowed(now, false)) return { open: true, exception: false };
      const c = this.freshRegime("CRYPTO", now);
      if (!c || c.score === null) return { open: false, reason: "crypto regime gate closed (stale)" };
      if (c.score >= lane.crypto_composite_floor && exceptional()) return { open: true, exception: true };
      return { open: false, reason: `crypto regime gate closed (score ${c.score.toFixed(0)})` };
    }
    if (arena === "EQUITIES") {
      const eq = this.freshRegime("EQUITIES", now);
      if (!eq) return { open: false, reason: "equity posture stale" };
      if (this.d.regime_gates.equity_postures_allowing_entries.includes(eq.posture))
        return { open: true, exception: false };
      if ((lane.equity_postures as string[]).includes(eq.posture) && exceptional())
        return { open: true, exception: true };
      return { open: false, reason: `equity posture ${eq.posture}` };
    }
    return { open: true, exception: false };
  }

  /**
   * Clairic catalyst facts (ADR-043): one extraction per candidate, cached in hot KV so Tier 2 and the court share it.
   * Budgeted like any Workers AI call; any failure means "no facts", never a blocked candidate.
   */
  private async catalystFacts(
    candidateId: string,
    text: string,
    createdAt: number,
    now: number,
  ): Promise<CatalystFacts | null> {
    const cfg = this.d.funnel.facts;
    const api = this.deps.clairic;
    if (!api || !cfg.enabled || text.length < cfg.min_chars) return null;
    const key = `facts:${candidateId}`;
    const cached = getKV(this.sql, key);
    if (cached !== null) return cached === "none" ? null : (JSON.parse(cached) as CatalystFacts);
    if (this.daily("clairic", now) >= cfg.max_per_day) return null;
    const est = Math.ceil((text.length + JSON.stringify(FACT_FIELDS).length) / 3.2);
    const cost = (est * (this.d.budgets.neurons_per_mtok.clairic ?? 9091)) / 1_000_000;
    if (!this.budget.canSpendNeurons("neurons_clairic", cost, now)) return null;
    this.bumpDaily("clairic", now);
    this.sql.exec("DELETE FROM settings WHERE key LIKE 'facts:%' AND updated_at < ?", now - 2 * 86_400_000);
    try {
      const r = await api.run(
        text.slice(0, 4000),
        FACT_FIELDS,
        new Date(createdAt).toISOString().slice(0, 10),
      );
      const used = r.usage?.input_tokens ?? est;
      this.budget.add(
        "neurons_clairic",
        (used * (this.d.budgets.neurons_per_mtok.clairic ?? 9091)) / 1_000_000,
        now,
      );
      const facts = interpretFacts(r, cfg.min_confidence);
      setKV(this.sql, key, JSON.stringify(facts), now);
      return facts;
    } catch (e) {
      setKV(this.sql, key, "none", now);
      throw e;
    }
  }

  /** Exception-lane contracts currently held or working on any account. */
  private openExceptions(): number {
    const ids = new Set<string>();
    for (const a of ACCOUNTS) {
      for (const p of this.positions(a)) ids.add(p.contract_id);
      for (const o of this.openOrders(a)) if (o.role === "ENTRY") ids.add(o.contract_id);
    }
    let n = 0;
    for (const id of ids) {
      const c = one<{ json: string }>(this.sql, "SELECT json FROM contracts WHERE contract_id = ?", id);
      if (c?.json.includes('"regime_exception"')) n++;
    }
    return n;
  }

  /** Tier 0: resolve a queue row into tradeable evidence, or a reason it can't be. */
  private async evidenceFor(
    row: { candidate_id: string; payload_json: string; enqueued_at: number },
    now: number,
  ): Promise<
    | { ok: true; evidence: Evidence }
    | { ok: false; reason: string; symbol: string; arena: string; hypothetical?: Record<string, unknown> }
  > {
    const p = JSON.parse(row.payload_json) as Record<string, unknown>;
    const t1 = (p.tier1 ?? null) as { material: number; direction: string; escalate: number } | null;
    const symbols = Array.isArray(p.symbols) ? (p.symbols as string[]) : [];
    const target = resolveTradeable(symbols, this.d);
    if (!target) return { ok: false, reason: "no tradeable symbol", symbol: symbols[0] ?? "", arena: "?" };
    const { symbol, arena } = target;
    if (t1?.direction === "down") return { ok: false, reason: "bearish catalyst (long-only)", symbol, arena };
    if (this.symbolsInPlay().includes(symbol)) return { ok: false, reason: "already held", symbol, arena };
    const gate = this.regimeGate(arena, t1, now);
    const m = this.deps.market;
    if (!m) return { ok: false, reason: gate.open ? "no market data" : gate.reason, symbol, arena };
    const [bars, quotes] = await Promise.all([
      arena === "CRYPTO" ? m.cryptoDailyBars([symbol], 70, now) : m.stockDailyBars([symbol], 70, now),
      this.quotesFor([symbol]),
    ]);
    const q = quotes[symbol];
    const b = bars[symbol];
    if (!gate.open) {
      // Gradeable refusal (ADR-039): bid + ATR let the Governor score what the gate saved or missed.
      const a14 = b ? atr(b, 14) : null;
      return {
        ok: false,
        reason: gate.reason,
        symbol,
        arena,
        hypothetical: q && a14 ? { bid: q.bid, atr: a14, gate: true } : {},
      };
    }
    if (!q || !b) return { ok: false, reason: "no quote or bars", symbol, arena };
    const created = typeof p.createdAt === "number" ? p.createdAt : row.enqueued_at;
    const facts = await this.catalystFacts(
      row.candidate_id,
      `${String(p.headline ?? "")}\n${String(p.summary ?? "")}`.trim(),
      created,
      now,
    ).catch(() => null);
    const evidence = buildEvidence({
      symbol,
      arena,
      bars: b,
      bid: q.bid,
      ask: q.ask,
      now,
      regime: this.regimeContext(now),
      world: this.worldContext(now),
      catalyst: {
        candidateId: row.candidate_id,
        kind: String(p.kind ?? "news"),
        headline: String(p.headline ?? "").slice(0, 300),
        source: String(p.source ?? "").slice(0, 40),
        url: typeof p.url === "string" && p.url.startsWith("https://") ? p.url : null,
        ageMinutes: Math.max(0, Math.round((now - created) / 60_000)),
        tier1: t1,
      },
      held: this.symbolsInPlay(),
      memory: this.memoryFor(symbol, arena, now),
      regimeException: gate.exception,
      facts,
      forecast: ((f) =>
        f
          ? {
              model: f.model,
              horizon_hours: f.horizon_hours,
              age_minutes: Math.round((now - f.produced_at) / 60_000),
              p_up: f.p_up,
              p_win: f.p_win,
              p_target_first: f.p_target_first,
              p_stop_first: f.p_stop_first,
              exp_ret: f.exp_ret,
            }
          : null)(this.kronosFor(symbol, now)),
    });
    return evidence ? { ok: true, evidence } : { ok: false, reason: "not enough bar history", symbol, arena };
  }

  /** Tier 2 (Clef 27B): one promoted candidate per pulse; pass → tier 3 (court queue). */
  private async triageTier2(): Promise<number> {
    const clef = this.deps.clef;
    if (!clef) return 0;
    const now = this.deps.now();
    const t2 = this.d.funnel.tier2;
    if (this.daily("tier2", now) >= t2.max_per_day) return 0;
    const row = one<{ candidate_id: string; payload_json: string; enqueued_at: number }>(
      this.sql,
      "SELECT candidate_id, payload_json, enqueued_at FROM triage_queue WHERE tier = 2 ORDER BY enqueued_at LIMIT 1",
    );
    if (!row) return 0;
    const ev = await this.evidenceFor(row, now);
    if (!ev.ok) {
      this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", row.candidate_id);
      this.rejectCandidate(
        { candidateId: row.candidate_id, symbol: ev.symbol, arena: ev.arena, source: "tier0" },
        "TIER0",
        [ev.reason],
        ev.hypothetical ?? {},
        now,
      );
      return 0;
    }
    const recent = Number(getKV(this.sql, `court_seen:${ev.evidence.symbol}`) ?? 0);
    if (now - recent < 6 * 3_600_000) {
      this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", row.candidate_id);
      return 0;
    }
    const req = buildTier2(ev.evidence);
    const est = estimateTokens(req.state, req.questions);
    if (!this.budget.canSpendNeurons("neurons_tier2", neuronsFor("clef", est, this.d), now)) return 0;
    this.bumpDaily("tier2", now);
    // One attempt per candidate (like the court): a failing Clef call must not block the queue behind it.
    this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", row.candidate_id);
    const started = this.deps.now();
    const result = await clef.run("clef", req.state, req.questions);
    const neurons = neuronsFor("clef", result.usage.input_tokens ?? est, this.d);
    this.budget.add("neurons_tier2", neurons, now);
    const dcs = interpretTier2(result, this.d, { exception: ev.evidence.regimeException });
    this.journal.enqueue(
      "triage_log",
      {
        ts: now,
        tier: 2,
        model: "clef",
        candidate_ids: JSON.stringify([row.candidate_id]),
        state_sha256: sha256Hex(JSON.stringify(req.state)),
        answers_json: JSON.stringify({ prompt: TIER2_PROMPT_VERSION, symbol: ev.evidence.symbol, ...dcs }),
        neurons_est: neurons,
        latency_ms: this.deps.now() - started,
      },
      now,
    );
    if (!dcs.pass) {
      this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", row.candidate_id);
      this.rejectCandidate(
        {
          candidateId: row.candidate_id,
          symbol: ev.evidence.symbol,
          arena: ev.evidence.arena,
          source: "tier2",
        },
        "TIER2",
        dcs.reasons,
        { bid: ev.evidence.quote.bid, atr: ev.evidence.technicals.atr14 },
        now,
      );
      return 1;
    }
    const payload = {
      ...(JSON.parse(row.payload_json) as Record<string, unknown>),
      tier2: dcs,
      symbol: ev.evidence.symbol,
    };
    // The row was consumed before the Clef call (one attempt); a pass re-queues it for the court.
    this.sql.exec(
      "INSERT OR REPLACE INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 3, ?, ?, ?)",
      row.candidate_id,
      ev.evidence.symbol,
      JSON.stringify(payload),
      row.enqueued_at,
    );
    this.journal.append(
      "SYSTEM",
      "TIER2_PASS",
      row.candidate_id,
      { symbol: ev.evidence.symbol, quality: dcs.quality100, long: dcs.longFavored },
      now,
    );
    return 1;
  }

  /**
   * Operator-requested court session (`/court SYMBOL`): skips Tiers 1–2 but not Tier 0 gates, the daily cap, the
   * kill flag, the budget mode, or the validator/sizer. Runs immediately.
   */
  async requestCourt(symbolInput: string, by: string): Promise<string> {
    const now = this.deps.now();
    const target = resolveTradeable([symbolInput.trim()], this.d);
    if (!target) return `${symbolInput} isn't in the tradeable universe (doctrine watchlists).`;
    const kill = await this.readKill();
    if (kill !== "CLEAR") return `Kill flag is ${kill}; no court sessions.`;
    if (this.budget.snapshot(now).mode === "REDUCE_ONLY")
      return "Budget is in REDUCE_ONLY; no court sessions.";
    if (this.daily("court", now) >= this.d.funnel.tier3.max_sprints_per_day)
      return "Daily court cap reached.";
    const id = `operator:${target.symbol}:${now}`;
    this.sql.exec(
      "INSERT INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 3, ?, ?, ?)",
      id,
      target.symbol,
      JSON.stringify({
        kind: "operator",
        headline: `Operator-requested review of ${target.symbol} (no specific catalyst — judge technicals, regime and world context)`,
        symbols: [target.symbol],
        source: by,
        createdAt: now,
      }),
      now - 365 * 86_400_000, // front of the court queue
    );
    this.journal.append("SYSTEM", "COURT_REQUEST", id, { symbol: target.symbol, by }, now);
    const n = await this.runCourt();
    await this.flushJournal();
    return n > 0
      ? `Court session for ${target.symbol} finished — see #bull-vs-bear-court.`
      : `Court session for ${target.symbol} ended without a contract — see #bull-vs-bear-court or the journal.`;
  }

  /** Completed COURT trades so far (calibration weight). */
  private resolvedCourtOutcomes(): number {
    return (
      one<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM exits e JOIN contracts c ON c.contract_id = e.contract_id WHERE json_extract(c.json, '$.origin') = 'COURT'",
      )?.n ?? 0
    );
  }

  private logLlm(sprintId: string, role: string, promptVersion: string, a: HopAttempt, now: number): void {
    this.journal.enqueue(
      "llm_calls",
      {
        ts: now,
        sprint_id: sprintId,
        role,
        provider: a.provider,
        model: a.model,
        family: a.family,
        prompt_version: promptVersion,
        input_tokens: a.inputTokens,
        output_tokens: a.outputTokens,
        latency_ms: a.latencyMs,
        outcome: a.outcome,
        output_sha256: a.error ? sha256Hex(a.error) : null,
      },
      now,
    );
  }

  /**
   * Tier 3 court: bull (chain A) → bear (chain B, different family) → Clef 27B synthesis → calibrated COURT
   * contract → the same validator/sizer as everything else. One sprint per pulse, capped per day.
   */
  private async runCourt(): Promise<number> {
    const llm = this.deps.llm;
    const clef = this.deps.clef;
    if (!llm || !clef) return 0;
    const now = this.deps.now();
    if (this.daily("court", now) >= this.d.funnel.tier3.max_sprints_per_day) return 0;
    const row = one<{ candidate_id: string; payload_json: string; enqueued_at: number }>(
      this.sql,
      "SELECT candidate_id, payload_json, enqueued_at FROM triage_queue WHERE tier = 3 ORDER BY enqueued_at LIMIT 1",
    );
    if (!row) return 0;
    this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", row.candidate_id); // one shot per candidate
    const ev = await this.evidenceFor(row, now);
    if (!ev.ok) {
      this.rejectCandidate(
        { candidateId: row.candidate_id, symbol: ev.symbol, arena: ev.arena, source: "court" },
        "TIER0",
        [ev.reason],
        ev.hypothetical ?? {},
        now,
      );
      return 0;
    }
    const e = ev.evidence;
    const vetoes = scarVetoes(
      this.scarRules(),
      this.facts(e.arena, COURT_STRATEGY[e.arena], "COURT", e.symbol, this.catalystKey(e.receipts), now),
      utcDay(now),
    );
    if (vetoes.length > 0) {
      this.rejectCandidate(
        { candidateId: row.candidate_id, symbol: e.symbol, arena: e.arena, source: "court" },
        "SCAR",
        vetoes.map((r) => `${r.id}: ${r.rule}`),
        {},
        now,
      );
      return 0;
    }
    this.bumpDaily("court", now);
    setKV(this.sql, `court_seen:${e.symbol}`, String(now), now);
    const sprintId = uuidv7(now);
    const cand = { candidateId: row.candidate_id, symbol: e.symbol, arena: e.arena, source: "court" };
    const evidenceJson = JSON.stringify(evidenceForModels(e));
    const session: CourtSession = {
      symbol: e.symbol,
      arena: e.arena,
      catalyst: e.catalyst,
      bid: e.quote.bid,
      atr: e.technicals.atr14,
      facts: e.facts?.values ?? null,
      kronos: e.forecast?.view ?? null,
    };
    const close = async (verdict: string, ok: boolean) => {
      session.verdict = verdict;
      session.ok = ok;
      await this.deps.notifier.post("court", courtSessionCard(session));
    };

    const bull = await llm.run(
      this.d.llm_routing.bull_chain,
      {
        system: BULL_SYSTEM,
        user: `Evidence JSON (ids for receipts: ${e.receipts.map((r) => r.evidence_id).join(", ")}):\n${evidenceJson}`,
        maxOutputTokens: 1500,
        schema: BULL_SCHEMA as unknown as Record<string, unknown>,
      },
      (j) => BullSchema.parse(j),
      [],
      (a) => this.logLlm(sprintId, "BULL", BULL_PROMPT_VERSION, a, this.deps.now()),
    );
    if (!bull) {
      this.rejectCandidate(cand, "BULL", ["no bull provider produced valid output"], {}, now);
      await close("❌ No bull: every provider failed or broke the schema", false);
      return 0;
    }
    session.bull = { ...bull.value, by: `${bull.provider}/${bull.model}` };
    const checked = checkBull(bull.value, e, this.d);
    if (!checked.ok) {
      this.rejectCandidate(cand, "BULL", checked.reasons, { ...bull.value }, now);
      await close(`🚫 Rejected by code before the bear: ${checked.reasons.join("; ")}`, false);
      return 0;
    }

    const bear = await llm.run(
      this.d.llm_routing.bear_chain,
      {
        system: BEAR_SYSTEM,
        user: `Evidence JSON:\n${evidenceJson}\n\nBull brief JSON:\n${JSON.stringify(checked.bull)}`,
        maxOutputTokens: 1500,
        schema: BEAR_SCHEMA as unknown as Record<string, unknown>,
      },
      (j) => BearSchema.parse(j),
      this.d.llm_routing.require_cross_family ? [bull.family] : [],
      (a) => this.logLlm(sprintId, "BEAR", BEAR_PROMPT_VERSION, a, this.deps.now()),
    );
    if (!bear) {
      this.rejectCandidate(cand, "BEAR", ["no cross-family bear available"], { ...checked.bull }, now);
      await close("❌ No cross-family bear available — not traded single-family", false);
      return 0;
    }
    session.bear = { ...bear.value, by: `${bear.provider}/${bear.model}` };

    // ADR-044: the bull answers the bear (withdrawing ends the session), then the expert panel weighs in.
    const panelCfg = this.d.llm_routing.panel;
    let rebuttal: Rebuttal | null = null;
    if (panelCfg.rebuttal) {
      const r = await llm.run(
        [{ provider: bull.provider, model: bull.model }, ...this.d.llm_routing.bull_chain],
        {
          system: REBUTTAL_SYSTEM,
          user: `Evidence JSON:\n${evidenceJson}\n\nYour brief JSON:\n${JSON.stringify(checked.bull)}\n\nBear attack JSON:\n${JSON.stringify(bear.value)}`,
          maxOutputTokens: 1200,
          schema: REBUTTAL_SCHEMA as unknown as Record<string, unknown>,
        },
        (j) => RebuttalSchema.parse(j),
        this.d.llm_routing.require_cross_family ? [bear.family] : [],
        (a) => this.logLlm(sprintId, "REBUTTAL", REBUTTAL_PROMPT_VERSION, a, this.deps.now()),
      );
      if (r) {
        rebuttal = {
          ...r.value,
          revised_conviction: Math.min(r.value.revised_conviction, checked.bull.conviction),
        };
        session.rebuttal = { ...rebuttal, by: `${r.provider}/${r.model}` };
        if (!rebuttal.still_long) {
          this.rejectCandidate(
            cand,
            "REBUTTAL",
            ["bull withdrew after the bear's attack"],
            { ...checked.bull },
            now,
          );
          await close("🏳️ The bull withdrew after cross-examination — no trade", false);
          return 0;
        }
      }
    }
    const panel = (
      await Promise.all(
        panelCfg.seats.map(async (id, i) => {
          const seat = PANEL_SEATS.find((s) => s.id === id);
          if (!seat || panelCfg.chain.length === 0) return null;
          // rotate the chain so seats spread across providers; prefer families not yet heard, else any
          const chain = [...panelCfg.chain.slice(i), ...panelCfg.chain.slice(0, i)];
          const req = {
            system: panelSystem(seat),
            user: `Evidence JSON:\n${evidenceJson}\n\nBull brief:\n${JSON.stringify(checked.bull)}\n\nBear attack:\n${JSON.stringify(bear.value)}${rebuttal ? `\n\nBull rebuttal:\n${JSON.stringify(rebuttal)}` : ""}`,
            maxOutputTokens: 800,
            schema: PANEL_SCHEMA as unknown as Record<string, unknown>,
          };
          const log = (a: HopAttempt) =>
            this.logLlm(sprintId, `PANEL_${id.toUpperCase()}`, PANEL_PROMPT_VERSION, a, this.deps.now());
          const parse = (j: unknown) => PanelOpinionSchema.parse(j);
          const r = await llm.run(chain, req, parse, [], log, panelCfg.timeout_ms);
          return r
            ? ({
                ...r.value,
                seat: id,
                title: seat.title,
                emoji: seat.emoji,
                by: `${r.provider}/${r.model}`,
              } as SeatOpinion)
            : null;
        }),
      )
    ).filter((x): x is SeatOpinion => x !== null);
    session.panel = panel;

    const synthReq = buildSynth(e, checked.bull, bear.value, { rebuttal, panel });
    const est = estimateTokens(synthReq.state, synthReq.questions);
    if (!this.budget.canSpendNeurons("neurons_tier2", neuronsFor("clef", est, this.d), now)) {
      this.rejectCandidate(
        cand,
        "BUDGET",
        ["tier-2 neurons exhausted for synthesis"],
        { ...checked.bull },
        now,
      );
      await close("⏸ Clef budget for today is spent — synthesis skipped", false);
      return 0;
    }
    const synthRes = await clef.run("clef", synthReq.state, synthReq.questions);
    this.budget.add("neurons_tier2", neuronsFor("clef", synthRes.usage.input_tokens ?? est, this.d), now);
    const synth = interpretSynth(synthRes);
    if (!synth) {
      this.rejectCandidate(cand, "SYNTH", ["incomplete Clef synthesis"], { ...checked.bull }, now);
      await close("❌ Clef synthesis incomplete", false);
      return 0;
    }
    const calibrated = calibrate(
      synth.winProb,
      this.resolvedCourtOutcomes(),
      this.d,
      this.deps.calibration?.maps["court.win_prob"] ?? null,
    );
    session.synth = { ...synth, calibrated };
    const viaAccount = (this.d.strategies.find((s) => s.arena === e.arena && s.status === "ACTIVE")
      ?.accounts[0] ?? "PAPER") as AccountId;
    const meta = await this.assetMeta(e.symbol, viaAccount).catch(() => null);
    const tick = meta?.price_increment ? Number(meta.price_increment) : defaultTick(e.quote.bid, e.arena);
    const contract = buildCourtContract({
      contractId: uuidv7(now),
      now,
      evidence: e,
      bull: rebuttal ? { ...checked.bull, conviction: rebuttal.revised_conviction } : checked.bull,
      bear: bear.value,
      synth,
      calibratedWin: calibrated,
      tick,
      models: {
        bull: { provider: bull.provider, model: bull.model, family: bull.family },
        bear: { provider: bear.provider, model: bear.model, family: bear.family },
      },
      d: this.d,
    });
    const parsed = DecisionContractSchema.safeParse(contract);
    const violations = parsed.success
      ? contractViolations(parsed.data)
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    if (violations.length > 0) {
      this.rejectCandidate(cand, "CONTRACT", violations.slice(0, 6), { ...checked.bull }, now);
      await close(`🚫 Contract invalid: ${violations.slice(0, 3).join("; ")}`, false);
      return 0;
    }
    this.recordContract(contract, now);
    this.journal.append(
      "SYSTEM",
      "COURT",
      contract.contract_id,
      {
        sprint: sprintId,
        symbol: e.symbol,
        win_raw: synth.winProb,
        win_cal: calibrated,
        bear: bear.value.lethality,
        notes: checked.notes,
      },
      now,
    );
    const strategy = this.d.strategies.find((s) => s.id === contract.strategy_id);
    const quotes = await this.quotesFor([e.symbol]).catch(() => ({}) as Record<string, Quote>);
    const outcomes: string[] = [];
    let traded = false;
    for (const account of strategy?.accounts ?? []) {
      if (!this.deps.brokers[account]) continue;
      this.lastRejections.delete(contract.contract_id);
      const ok = await this.route(account, contract, quotes);
      traded ||= ok;
      const why = this.lastRejections.get(contract.contract_id);
      outcomes.push(
        ok
          ? `✅ ${account}: entry order placed`
          : why
            ? `🛑 ${account}: declined by the risk engine — ${why.slice(0, 3).join("; ")}`
            : `👻 ${account}: shadow only (autonomy dial)`,
      );
    }
    session.contractId = contract.contract_id;
    await close(outcomes.join("\n") || "No account enabled for this strategy", traded);
    return 1;
  }

  /**
   * Tier 1 (CLAUDE.md §3): batch the oldest tier-1 queue items into one clef-flash call. Promote material,
   * high-priority items to tier 2 (posted to #world-intel); drop the rest. Spend is metered from Clef's own
   * token usage; when the daily tier-1 allocation is spent, triage waits for 00:00 UTC.
   */
  private async triageTier1(): Promise<{ triaged: number; promoted: number }> {
    const clef = this.deps.clef;
    if (!clef) return { triaged: 0, promoted: 0 };
    const now = this.deps.now();
    const t = this.d.funnel.tier1;
    const rows = this.sql.exec<{
      candidate_id: string;
      symbol: string;
      payload_json: string;
      enqueued_at: number;
    }>(
      "SELECT candidate_id, symbol, payload_json, enqueued_at FROM triage_queue WHERE tier = 1 ORDER BY enqueued_at LIMIT ?",
      t.batch_max_items,
    );
    if (rows.length === 0) return { triaged: 0, promoted: 0 };
    let items: TriageItem[] = rows.map((r) => {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      const created = typeof p.createdAt === "number" ? p.createdAt : r.enqueued_at;
      return {
        candidateId: r.candidate_id,
        kind: String(p.kind ?? "news"),
        symbols: Array.isArray(p.symbols) ? (p.symbols as string[]).slice(0, 8) : [r.symbol],
        headline: String(p.headline ?? p.title ?? "").slice(0, 300),
        summary: String(p.summary ?? "").slice(0, 280),
        source: String(p.source ?? "").slice(0, 40),
        ageMinutes: Math.max(0, Math.round((now - created) / 60_000)),
      };
    });
    const context = {
      held: this.symbolsInPlay(),
      watched: this.newsSymbols().slice(0, 20),
      crypto_regime: this.freshRegime("CRYPTO", now)?.posture ?? "unknown",
      equity_posture: this.freshRegime("EQUITIES", now)?.posture ?? "unknown",
    };
    let req = buildTier1(items, context);
    while (estimateTokens(req.state, req.questions) > CLEF_CONTEXT_TOKENS * 0.85 && items.length > 1) {
      items = items.slice(0, Math.ceil(items.length / 2));
      req = buildTier1(items, context);
    }
    const est = estimateTokens(req.state, req.questions);
    if (!this.budget.canSpendNeurons("neurons_tier1", neuronsFor("clef-flash", est, this.d), now)) {
      return { triaged: 0, promoted: 0 };
    }
    const started = this.deps.now();
    let result: Awaited<ReturnType<ClefApi["run"]>>;
    try {
      result = await clef.run("clef-flash", req.state, req.questions);
    } catch (e) {
      if (/neuron|quota|limit|exceeded|4006/i.test(errText(e))) {
        // Workers AI says we're out: stop tier 1 for the rest of the UTC day.
        this.budget.add("neurons_tier1", this.d.budgets.workers_ai_neurons_per_day.tier1, now);
      }
      throw e;
    }
    const latency = this.deps.now() - started;
    const neurons = neuronsFor("clef-flash", result.usage.input_tokens ?? est, this.d);
    this.budget.add("neurons_tier1", neurons, now);

    const decisions = interpretTier1(items, result, this.d);
    let promoted = 0;
    for (const [i, dcs] of decisions.entries()) {
      const it = items[i] as TriageItem;
      if (!dcs.promote) {
        this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", dcs.candidateId);
        continue;
      }
      promoted++;
      const row = rows.find((r) => r.candidate_id === dcs.candidateId);
      const payload = { ...(JSON.parse(row?.payload_json ?? "{}") as Record<string, unknown>), tier1: dcs };
      this.sql.exec(
        "UPDATE triage_queue SET tier = 2, payload_json = ? WHERE candidate_id = ?",
        JSON.stringify(payload),
        dcs.candidateId,
      );
      if (promoted <= 5) void this.deps.notifier.post("world_intel", intelCard(it, dcs, payload));
    }
    this.journal.enqueue(
      "triage_log",
      {
        ts: now,
        tier: 1,
        model: "clef-flash",
        candidate_ids: JSON.stringify(items.map((x) => x.candidateId)),
        state_sha256: sha256Hex(JSON.stringify(req.state)),
        answers_json: JSON.stringify({ prompt: TIER1_PROMPT_VERSION, decisions }).slice(0, 60_000),
        neurons_est: neurons,
        latency_ms: latency,
      },
      now,
    );
    this.journal.append(
      "SYSTEM",
      "TRIAGE",
      null,
      { tier: 1, items: items.length, promoted, neurons: Math.round(neurons * 100) / 100 },
      now,
    );
    return { triaged: items.length, promoted };
  }

  /** Research batch from GitHub Actions (HMAC already verified by the router). Returns a short receipt. */
  async ingestBatch(raw: unknown): Promise<{ ok: boolean; message: string }> {
    const now = this.deps.now();
    const parsed = BatchSchema.safeParse(raw);
    if (!parsed.success) {
      this.journal.append(
        "SYSTEM",
        "INGEST_REJECTED",
        null,
        { issues: parsed.error.issues.slice(0, 5) },
        now,
      );
      return { ok: false, message: "schema validation failed" };
    }
    const b: Batch = parsed.data;
    if (b.produced_at > now + 5 * 60_000) return { ok: false, message: "produced_at is in the future" };
    for (const item of b.items) {
      this.journal.enqueue(
        "batch_results",
        {
          received_at: now,
          produced_at: b.produced_at,
          job: b.job,
          skill_id: item.skill_id,
          version: item.version,
          inputs_sha256: item.inputs_sha256,
          payload_json: JSON.stringify(item.payload).slice(0, 60_000),
          run_url: b.run_url,
        },
        now,
      );
    }
    if (b.job === "governor") return this.ingestGovernor(b, now);
    if (b.job === "options-lab") return this.ingestOptionsLab(b, now);
    if (b.job === "screeners") return this.ingestScreeners(b, now);
    if (b.job === "kronos") return this.ingestKronos(b, now);
    if (b.job === "world-intel" || b.posture === null) {
      const pulse = b.items.find((x) => x.skill_id === "gdelt-world-pulse")?.payload as
        | {
            groups?: Record<string, { share?: number; tone?: number | null }>;
            tone?: number | null;
            articles?: number;
          }
        | undefined;
      if (pulse?.groups) {
        this.sql.exec(
          "INSERT INTO regime_state (arena, posture, score, ceiling, payload_json, as_of) VALUES ('WORLD', 'INFO', ?, NULL, ?, ?) ON CONFLICT(arena) DO UPDATE SET posture = excluded.posture, score = excluded.score, payload_json = excluded.payload_json, as_of = excluded.as_of",
          Math.round((pulse.groups.conflict?.share ?? 0) * 1000) / 10,
          JSON.stringify({
            source: "world-intel",
            groups: pulse.groups,
            tone: pulse.tone ?? null,
            articles: pulse.articles ?? null,
          }),
          b.produced_at,
        );
      }
      let queued = 0;
      for (const item of b.items) {
        const list = (item.payload as { candidates?: unknown }).candidates;
        if (!Array.isArray(list)) continue;
        for (const c of list.slice(0, 100)) {
          const parsedC = WorldCandidateSchema.safeParse(c);
          if (!parsedC.success) continue;
          const w = parsedC.data;
          const id = `${w.kind}:${w.id}`;
          if (!this.markSeen(id, now)) continue;
          this.sql.exec(
            "INSERT INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 1, ?, ?, ?)",
            id,
            w.symbols[0] ?? "",
            JSON.stringify({
              kind: w.kind,
              headline: w.title,
              summary: w.topic ? `topic: ${w.topic}` : "",
              symbols: w.symbols,
              source: w.source,
              url: w.url,
              createdAt: w.published_at,
            }),
            now,
          );
          queued++;
        }
      }
      if (queued > 0) this.journal.append("SYSTEM", "WORLD_INTAKE", b.job, { queued }, now);
      await this.flushJournal();
      return { ok: true, message: `queued ${queued} world-intel candidate(s)` };
    }
    const prev = one<{ posture: string; score: number | null }>(
      this.sql,
      "SELECT posture, score FROM regime_state WHERE arena = ?",
      b.posture.arena,
    );
    this.sql.exec(
      "INSERT INTO regime_state (arena, posture, score, ceiling, payload_json, as_of) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(arena) DO UPDATE SET posture = excluded.posture, score = excluded.score, ceiling = excluded.ceiling, payload_json = excluded.payload_json, as_of = excluded.as_of",
      b.posture.arena,
      b.posture.posture,
      b.posture.score,
      b.posture.ceiling,
      JSON.stringify({
        source: b.job,
        confidence: b.posture.confidence,
        summary: b.posture.summary,
        run_url: b.run_url,
      }),
      b.produced_at,
    );
    this.journal.append(
      "SYSTEM",
      "REGIME",
      b.job,
      {
        arena: b.posture.arena,
        posture: b.posture.posture,
        score: b.posture.score,
        ceiling: b.posture.ceiling,
        from: prev?.posture ?? null,
      },
      now,
    );
    const cal = b.items.find((x) => x.skill_id === "earnings-calendar")?.payload as
      | { events?: { symbol?: unknown; date?: unknown }[] }
      | undefined;
    if (cal && Array.isArray(cal.events)) {
      this.sql.exec("DELETE FROM earnings");
      for (const ev of cal.events.slice(0, 3000)) {
        if (
          typeof ev.symbol !== "string" ||
          typeof ev.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)
        )
          continue;
        this.sql.exec(
          "INSERT OR REPLACE INTO earnings (symbol, date) VALUES (?, ?)",
          ev.symbol.toUpperCase().slice(0, 12),
          ev.date,
        );
      }
      setKV(this.sql, "earnings_as_of", String(b.produced_at), now);
    }
    await this.deps.notifier.post("briefs", postureCard(b, prev?.posture ?? null));
    await this.flushJournal();
    return { ok: true, message: `stored ${b.items.length} item(s); ${b.posture.arena} ${b.posture.posture}` };
  }

  /** Governor results (Phase 4): append-only grades/postmortems, upserted reputation/fitness, optional report card. */
  private async ingestGovernor(b: Batch, now: number): Promise<{ ok: boolean; message: string }> {
    const counts = { grades: 0, postmortems: 0, reputation: 0, beliefs: 0, fitness: 0, cards: 0 };
    const list = (p: Record<string, unknown>, k: string) =>
      Array.isArray(p[k]) ? (p[k] as unknown[]).slice(0, 2000) : [];
    for (const item of b.items) {
      const p = item.payload;
      for (const g of list(p, "grades")) {
        const r = GradeSchema.safeParse(g);
        if (!r.success) continue;
        this.journal.enqueue("rejection_grades", { ...r.data }, now);
        counts.grades++;
      }
      for (const m of list(p, "postmortems")) {
        const r = PostmortemSchema.safeParse(m);
        if (!r.success || !this.markSeen(`pm:${r.data.contract_id}:${r.data.account}`, now)) continue;
        this.journal.enqueue("postmortems", { created_at: now, author: "governor", ...r.data }, now);
        counts.postmortems++;
      }
      const rep: Record<string, { weight: number; signals: number }> = {};
      for (const s of list(p, "reputation")) {
        const r = ReputationSchema.safeParse(s);
        if (!r.success) continue;
        this.journal.enqueue("source_reputation", { ...r.data, updated_at: now }, now);
        rep[r.data.source] = { weight: r.data.weight, signals: r.data.signals };
        counts.reputation++;
      }
      if (Object.keys(rep).length > 0) setKV(this.sql, "reputation", JSON.stringify(rep), now);
      for (const raw of list(p, "beliefs")) {
        const r = BeliefSchema.safeParse(raw);
        if (!r.success) continue;
        const b = r.data;
        this.sql.exec(
          "INSERT OR REPLACE INTO beliefs (belief_id, subject, statement, c0, half_life_days, validated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
          b.belief_id,
          b.subject,
          b.statement,
          b.c0,
          b.half_life_days,
          b.validated_at,
          b.status,
        );
        this.journal.enqueue(
          "beliefs",
          { ...b, tags: JSON.stringify(b.tags), evidence: JSON.stringify(b.evidence) },
          now,
        );
        counts.beliefs++;
      }
      for (const f of list(p, "fitness")) {
        const r = FitnessSchema.safeParse(f);
        if (!r.success) continue;
        this.journal.enqueue("skill_fitness", { ...r.data }, now);
        counts.fitness++;
      }
      if (typeof p.alarm === "string" && p.alarm.length > 0) {
        await this.deps.notifier.post("alarms", { content: p.alarm.slice(0, 1900) });
        this.journal.append("SYSTEM", "CHAIN_ALARM", null, { chain: p.chain ?? null }, now);
      }
      const card = ReportCardSchema.safeParse(p.card);
      if (card.success && card.data.post) {
        await this.deps.notifier.post("governor", {
          embeds: [
            {
              title: card.data.title,
              color: COLORS.cyan,
              fields: card.data.sections.map((s) => ({ name: s.name, value: s.value.slice(0, 1024) })),
              footer: { text: b.run_url ? "Governor · GitHub Actions" : "Governor" },
              timestamp: new Date(b.produced_at).toISOString(),
            },
          ],
        });
        counts.cards++;
      }
    }
    this.journal.append("SYSTEM", "GOVERNOR", null, counts, now);
    await this.flushJournal();
    return { ok: true, message: `governor: ${JSON.stringify(counts)}` };
  }

  /**
   * Options shadow lab (Phase 5, ADR-031): store virtual OPEN/CLOSE events. Nothing here reaches a broker; the
   * constitution's paper structure list and the doctrine's OPTIONS strategies are re-checked on the way in.
   */
  private async ingestOptionsLab(b: Batch, now: number): Promise<{ ok: boolean; message: string }> {
    const counts = { open: 0, close: 0, rejected: 0, cards: 0 };
    const allowed = new Set(this.c.allowed.options_structures_paper);
    for (const item of b.items) {
      const p = item.payload;
      const events = Array.isArray(p.events) ? (p.events as unknown[]).slice(0, 50) : [];
      for (const raw of events) {
        const r = OptionsEventSchema.safeParse(raw);
        const strat = r.success
          ? this.d.strategies.find((s) => s.id === r.data.strategy && s.arena === "OPTIONS")
          : undefined;
        if (
          !r.success ||
          !strat ||
          !allowed.has(r.data.structure) ||
          strat.params?.structure !== r.data.structure
        ) {
          counts.rejected++;
          continue;
        }
        const e = r.data;
        if (!this.markSeen(`opt:${e.trade_id}:${e.kind}`, now)) continue;
        this.journal.enqueue(
          "options_shadow",
          {
            trade_id: e.trade_id,
            kind: e.kind,
            ts: e.ts,
            strategy: e.strategy,
            structure: e.structure,
            underlying: e.underlying,
            legs_json: JSON.stringify(e.legs),
            cash: e.cash,
            max_loss_cents: e.max_loss_cents,
            max_profit_cents: e.max_profit_cents,
            fees_cents: e.fees_cents,
            pnl_cents: e.pnl_cents,
            r: e.r,
            reason: e.reason,
            sizer_permits_live: e.sizer_permits_live ? 1 : 0,
            detail_json: JSON.stringify(e.detail).slice(0, 4000),
          },
          now,
        );
        if (e.kind === "OPEN") counts.open++;
        else counts.close++;
      }
      const card = ReportCardSchema.safeParse(p.card);
      if (card.success && card.data.post && counts.open + counts.close > 0) {
        await this.deps.notifier.post("governor", {
          embeds: [
            {
              title: card.data.title,
              color: COLORS.cyan,
              fields: card.data.sections.map((s) => ({ name: s.name, value: s.value.slice(0, 1024) })),
              footer: { text: "Virtual ledger · never sent to a broker" },
              timestamp: new Date(b.produced_at).toISOString(),
            },
          ],
        });
        counts.cards++;
      }
    }
    this.journal.append("SYSTEM", "OPTIONS_LAB", null, counts, now);
    await this.flushJournal();
    return { ok: true, message: `options-lab: ${JSON.stringify(counts)}` };
  }

  /** Setup-screener hits (ADR-035) skip Tier 1 (they are setups, not news) and queue for Tier 2. */
  private async ingestScreeners(b: Batch, now: number): Promise<{ ok: boolean; message: string }> {
    if (now - b.produced_at > this.d.staleness.screener_batch_hours * 3_600_000) {
      return { ok: false, message: "screener batch is stale" };
    }
    let queued = 0;
    for (const item of b.items) {
      const list = (item.payload as { candidates?: unknown }).candidates;
      if (!Array.isArray(list)) continue;
      for (const raw of list.slice(0, 50)) {
        const r = ScreenerCandidateSchema.safeParse(raw);
        if (!r.success) continue;
        const c = r.data;
        const id = `screener:${c.id}`;
        if (!this.markSeen(id, now)) continue;
        this.sql.exec(
          "INSERT INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 2, ?, ?, ?)",
          id,
          c.symbol,
          JSON.stringify({
            kind: `screener:${c.screener.replace(/^stockbee-/, "").replace(/-screener$/, "")}`,
            headline: c.headline,
            summary: `score ${c.score} · ${c.state} · entry ref ${c.entry_reference ?? "?"} · stop ref ${c.stop_reference ?? "?"}`,
            symbols: [c.symbol],
            source: c.screener,
            url: null,
            createdAt: b.produced_at,
          }),
          now,
        );
        queued++;
      }
    }
    this.journal.append("SYSTEM", "SCREENER_INTAKE", null, { queued }, now);
    await this.flushJournal();
    return { ok: true, message: `queued ${queued} screener candidate(s) for Tier 2` };
  }

  /** Batch regime for an arena if it is within the doctrine staleness limit, else null (fail closed to proxy/none). */
  freshRegime(
    arena: "CRYPTO" | "EQUITIES",
    now: number,
  ): { posture: string; score: number | null; ceiling: number | null; as_of: number } | null {
    const row = one<{ posture: string; score: number | null; ceiling: number | null; as_of: number }>(
      this.sql,
      "SELECT posture, score, ceiling, as_of FROM regime_state WHERE arena = ?",
      arena,
    );
    if (!row) return null;
    const maxAge = (this.d.staleness.regime_batch_hours[arena] ?? 24) * 3_600_000;
    return now - row.as_of <= maxAge ? row : null;
  }

  /** Alert once per arena when batch data that used to arrive has gone stale (e.g. GitHub disabled the schedule). */
  private async checkBatchStaleness(now: number): Promise<void> {
    for (const arena of ["CRYPTO", "EQUITIES"] as const) {
      const row = one<{ as_of: number }>(this.sql, "SELECT as_of FROM regime_state WHERE arena = ?", arena);
      if (!row || this.freshRegime(arena, now)) continue;
      const hours = ((now - row.as_of) / 3_600_000).toFixed(1);
      await this.alertOnce(
        `stale-batch:${arena}`,
        `⏳ ${arena} regime batch is ${hours}h old (limit ${this.d.staleness.regime_batch_hours[arena]}h). Check the research workflow in GitHub Actions.`,
      );
    }
  }

  recordContract(contract: DecisionContract, now: number): void {
    const k = DecisionContractSchema.parse(contract);
    const json = JSON.stringify(k);
    this.sql.exec(
      "INSERT OR IGNORE INTO contracts (contract_id, symbol, json, created_at) VALUES (?, ?, ?, ?)",
      k.contract_id,
      k.symbol,
      json,
      now,
    );
    this.journal.enqueue(
      "decision_contracts",
      {
        contract_id: k.contract_id,
        created_at: k.created_at,
        symbol: k.symbol,
        arena: k.arena,
        strategy_id: k.strategy_id,
        thesis_summary: k.thesis_summary,
        bull_case_receipts: JSON.stringify(k.bull_case_receipts),
        bear_case_brief: k.bear_case_brief,
        kill_criteria: JSON.stringify(k.kill_criteria),
        invalidation_criteria: JSON.stringify(k.invalidation_criteria),
        entry_plan: JSON.stringify(k.entry_plan),
        clef_probabilities: JSON.stringify(k.clef_probabilities),
        cost_and_fee_drag: JSON.stringify(k.cost_and_fee_drag),
        proposed_conviction: k.proposed_conviction,
        models_used: JSON.stringify(k.models_used),
        schema_version: k.schema_version,
        contract_sha256: sha256Hex(json),
        origin: k.origin,
      },
      now,
    );
    this.journal.append(
      "SYSTEM",
      "CONTRACT",
      k.contract_id,
      { symbol: k.symbol, strategy: k.strategy_id, origin: k.origin },
      now,
    );
  }

  /**
   * Autonomy dial (ADR-024: there is no approve-each-trade mode). Below the account's trading stop the contract is
   * journaled as SHADOW and nothing is sent. PAPER trades from Stop 2; LIVE trades from Stop 3, which needs RATIFY.
   */
  private async route(
    account: AccountId,
    contract: DecisionContract,
    quotes: Record<string, Quote>,
  ): Promise<boolean> {
    const now = this.deps.now();
    const row = this.account(account);
    if (!row) return false;
    const autoAt = account === "PAPER" ? 2 : 3;
    if (row.autonomy_stop < autoAt) {
      this.journal.append(
        account,
        "SHADOW",
        contract.contract_id,
        { symbol: contract.symbol, stop: row.autonomy_stop },
        now,
      );
      return false;
    }
    return this.executeEntry(account, contract, quotes[contract.symbol] ?? null);
  }

  private async assetMeta(symbol: string, via: AccountId): Promise<AlpacaAsset | null> {
    const now = this.deps.now();
    const cached = one<{ json: string; fetched_at: number }>(
      this.sql,
      "SELECT json, fetched_at FROM asset_cache WHERE symbol = ?",
      symbol,
    );
    if (cached && now - cached.fetched_at < 86_400_000) return JSON.parse(cached.json) as AlpacaAsset;
    const broker = this.deps.brokers[via];
    if (!broker) return null;
    const a = await broker.asset(symbol);
    this.sql.exec(
      "INSERT INTO asset_cache (symbol, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
      symbol,
      JSON.stringify(a),
      now,
    );
    return a;
  }

  /** Validate → reserve (sync) → submit (await) → record. The core of ADR-004. */
  async executeEntry(account: AccountId, contract: DecisionContract, quote: Quote | null): Promise<boolean> {
    const broker = this.deps.brokers[account];
    if (!broker) return false;
    const now = this.deps.now();
    if (contract.arena === "EQUITIES") {
      const clock = await broker.clock();
      const minsToClose = (Date.parse(clock.next_close) - now) / 60_000;
      if (!clock.is_open || minsToClose < this.d.execution.no_entry_last_minutes_of_session) {
        this.reject(
          account,
          contract,
          "VALIDATOR",
          [clock.is_open ? "too close to the session close" : "market closed"],
          now,
        );
        return false;
      }
    }
    const sourceKey = this.catalystKey(contract.bull_case_receipts);
    const facts = this.facts(
      contract.arena,
      contract.strategy_id,
      contract.origin,
      contract.symbol,
      sourceKey,
      now,
    );
    const vetoes = scarVetoes(this.scarRules(), facts, utcDay(now));
    if (vetoes.length > 0) {
      this.reject(
        account,
        contract,
        "SCAR",
        vetoes.map((r) => `${r.id}: ${r.rule}`),
        now,
      );
      return false;
    }
    const guard = await this.entryGuards(account, contract, now);
    if (guard) {
      this.reject(account, contract, "VALIDATOR", [guard], now);
      return false;
    }
    const exception = contract.bull_case_receipts.some((r) => r.evidence_id === "regime_exception");
    const lane = this.d.regime_gates.exception_lane;
    if (exception && this.openExceptions() >= lane.max_concurrent) {
      this.reject(
        account,
        contract,
        "VALIDATOR",
        ["exception lane full (one exceptional position at a time)"],
        now,
      );
      return false;
    }
    const repWeight = this.reputationWeight(sourceKey);
    this.journal.append(
      account,
      "ENTRY_FACTS",
      contract.contract_id,
      { facts, reputation_weight: repWeight },
      now,
    );
    const q = quote ?? (await this.quotesFor([contract.symbol]))[contract.symbol] ?? null;
    const meta = await this.assetMeta(contract.symbol, account);
    if (!q || !meta) {
      this.reject(account, contract, "VALIDATOR", [!q ? "no quote" : "no asset metadata"], now);
      return false;
    }
    // ---- synchronous section: view → validate → reserve (no await until submit) ----
    const view = this.accountView(account, now);
    if (!view) return false;
    const asset: AssetView = {
      tradable: meta.tradable && meta.status === "active",
      fractionable: meta.fractionable,
      minQty: meta.min_order_size ? Number(meta.min_order_size) : 0,
      qtyIncrement: meta.min_trade_increment
        ? Number(meta.min_trade_increment)
        : contract.arena === "CRYPTO"
          ? 1e-9
          : 1e-9,
      minNotionalUsd: Math.max(1, this.d.execution.min_order_notional_usd[contract.arena] ?? 1),
    };
    const v = validateEntry(
      {
        contract,
        account: view,
        market: { bid: q.bid, ask: q.ask, quoteAt: q.at },
        asset,
        reputationWeight: repWeight,
        regimeMultiplier: exception ? lane.size_multiplier : 1,
        now,
      },
      this.d,
      this.c,
    );
    if (!v.ok) {
      this.reject(account, contract, "VALIDATOR", v.reasons, now);
      return false;
    }
    const riskCents = Math.ceil(v.sizing.riskUsd * 100);
    const notionalCents = Math.ceil(v.sizing.notionalUsd * 100);
    this.sql.exec(
      "INSERT INTO risk_reservations (contract_id, account, symbol, risk_cents, notional_cents, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      contract.contract_id,
      account,
      contract.symbol,
      riskCents,
      notionalCents,
      now + this.d.execution.reservation_ttl_seconds * 1000,
    );
    // ---- end synchronous section ----
    const tick = meta.price_increment
      ? Number(meta.price_increment)
      : defaultTick(v.entryPrice, contract.arena);
    const ok = await this.submit(account, broker, {
      contractId: contract.contract_id,
      role: "ENTRY",
      attempt: 1,
      side: "buy",
      symbol: contract.symbol,
      arena: contract.arena,
      type: "limit",
      tif: contract.arena === "CRYPTO" ? "gtc" : "day",
      qty: v.sizing.qty,
      limitPrice: roundPrice(v.entryPrice, tick, "down"),
      stopPrice: null,
      riskCents,
      notionalCents,
      extendedHours: false,
    });
    this.sql.exec(
      "DELETE FROM risk_reservations WHERE contract_id = ? AND account = ?",
      contract.contract_id,
      account,
    );
    if (ok) this.sql.exec("UPDATE accounts SET orders_today = orders_today + 1 WHERE account = ?", account);
    return ok;
  }

  private reject(
    account: AccountId,
    contract: DecisionContract,
    stage: string,
    reasons: string[],
    now: number,
  ): void {
    this.lastRejections.set(contract.contract_id, reasons);
    this.journal.enqueue(
      "rejections",
      {
        ts: now,
        candidate_id: contract.contract_id,
        contract_id: contract.contract_id,
        symbol: contract.symbol,
        arena: contract.arena,
        stage,
        reason_codes: JSON.stringify(reasons),
        hypothetical: JSON.stringify({
          entry: contract.entry_plan.zone_high,
          stop: contract.invalidation_criteria.stop_price,
          targets: contract.entry_plan.targets,
          horizon_hours: contract.invalidation_criteria.max_hold_hours,
        }),
        source: contract.strategy_id,
      },
      now,
    );
    this.journal.append(account, "REJECT", contract.contract_id, { stage, reasons }, now);
  }

  private async submit(
    account: AccountId,
    broker: BrokerApi,
    o: {
      contractId: string;
      role: OrderRole;
      attempt: number;
      side: "buy" | "sell";
      symbol: string;
      arena: Arena;
      type: "limit" | "stop" | "stop_limit";
      tif: "day" | "gtc" | "ioc";
      qty: string;
      limitPrice: string | null;
      stopPrice: string | null;
      riskCents: number;
      notionalCents: number;
      extendedHours: boolean;
    },
  ): Promise<boolean> {
    const now = this.deps.now();
    const coid = clientOrderId(account, o.contractId, o.role, o.attempt);
    const req = {
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      time_in_force: o.tif,
      qty: o.qty,
      client_order_id: coid,
      ...(o.limitPrice ? { limit_price: o.limitPrice } : {}),
      ...(o.stopPrice ? { stop_price: o.stopPrice } : {}),
      ...(o.extendedHours ? { extended_hours: true } : {}),
    };
    let res: Awaited<ReturnType<BrokerApi["submitOrder"]>> | null = null;
    try {
      res = await broker.submitOrder(req);
    } catch (e) {
      if (e instanceof BrokerError && e.status === 422 && /client_order_id/i.test(e.body)) {
        res = await broker.orderByClientId(coid); // duplicate: our earlier attempt landed
      }
      if (!res) {
        this.journal.append(account, "ORDER_FAILED", coid, { req, error: errText(e).slice(0, 500) }, now);
        await this.alertOnce(
          `order-failed:${coid}`,
          `❌ ${account} ${o.role} ${o.side} ${o.symbol} rejected: ${errText(e).slice(0, 200)}`,
        );
        return false;
      }
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO orders (client_order_id, account, contract_id, role, attempt, broker_order_id, state, side, symbol, arena,
         order_type, tif, qty, limit_price, stop_price, filled_qty, avg_fill_price, risk_cents, notional_cents, pulses_unfilled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      coid,
      account,
      o.contractId,
      o.role,
      o.attempt,
      res.id,
      res.status,
      o.side,
      o.symbol,
      o.arena,
      o.type,
      o.tif,
      o.qty,
      o.limitPrice,
      o.stopPrice,
      res.filled_qty,
      res.filled_avg_price ?? null,
      o.riskCents,
      o.notionalCents,
      now,
      now,
    );
    const row = one<OrderRow>(this.sql, "SELECT * FROM orders WHERE client_order_id = ?", coid);
    if (row) this.logOrder(account, row, "SUBMITTED", now);
    return true;
  }

  private logOrder(account: AccountId, o: OrderRow, event: string, now: number): void {
    this.journal.enqueue(
      "orders_log",
      {
        ts: now,
        account,
        contract_id: o.contract_id,
        client_order_id: o.client_order_id,
        broker_order_id: o.broker_order_id,
        event,
        side: o.side,
        order_type: o.order_type,
        qty: o.qty,
        notional_cents: o.notional_cents,
        limit_price: o.limit_price,
        stop_price: o.stop_price,
        detail_json: JSON.stringify({ role: o.role, state: o.state }),
      },
      now,
    );
    this.journal.append(
      account,
      "ORDER",
      o.client_order_id,
      { event, role: o.role, symbol: o.symbol, side: o.side, qty: o.qty },
      now,
    );
  }

  // ------------------------------------------------------------------ views

  accountView(account: AccountId, now: number): AccountView | null {
    const row = this.account(account);
    if (!row) return null;
    const eqCents = this.effectiveEquityCents(row);
    const positions = this.positions(account);
    const entries = this.openOrders(account).filter((o) => o.role === "ENTRY");
    const reservations = this.sql.exec<{ symbol: string; risk_cents: number; notional_cents: number }>(
      "SELECT symbol, risk_cents, notional_cents FROM risk_reservations WHERE account = ? AND expires_at >= ?",
      account,
      now,
    );
    const posRisk = positions.reduce(
      (s, p) =>
        s + Number(p.qty) * (Number(p.avg_entry) - Number(p.stop_price) + Number(p.avg_entry) * p.fee_rt),
      0,
    );
    const heatUsedUsd =
      posRisk +
      entries.reduce((s, o) => s + o.risk_cents / 100, 0) +
      reservations.reduce((s, r) => s + r.risk_cents / 100, 0);
    const pendingNotional =
      entries.reduce((s, o) => s + o.notional_cents, 0) +
      reservations.reduce((s, r) => s + r.notional_cents, 0);
    const unsettled =
      one<{ s: number | null }>(
        this.sql,
        "SELECT SUM(amount_cents) AS s FROM unsettled WHERE account = ? AND settles_at > ?",
        account,
        now,
      )?.s ?? 0;
    const cashCents =
      Math.min(row.cash_cents ?? 0, row.buying_power_cents ?? 0) - pendingNotional - unsettled;
    const symbols = new Set([
      ...positions.map((p) => p.symbol),
      ...entries.map((o) => o.symbol),
      ...reservations.map((r) => r.symbol),
    ]);
    const budgetMode = this.budget.snapshot(now).mode;
    const mode =
      row.mode !== "NORMAL"
        ? row.mode
        : budgetMode === "REDUCE_ONLY"
          ? "REDUCE_ONLY"
          : budgetMode === "THRIFT"
            ? "THRIFT"
            : "NORMAL";
    return {
      account,
      equityUsd: (eqCents ?? 0) / 100,
      availableCashUsd: Math.max(0, cashCents) / 100,
      rung: row.rung,
      band: row.breaker,
      breakerMultiplier: this.d.breakers.multipliers[row.breaker],
      autonomyStop: row.autonomy_stop,
      mode,
      killed: getKV(this.sql, "kill_seen") === "1",
      reconciledAt: row.reconciled_at,
      ordersToday: row.orders_today,
      heldOrPendingSymbols: [...symbols],
      openSlots: symbols.size,
      heatUsedUsd,
    };
  }

  positions(account: AccountId): PositionRow[] {
    return this.sql.exec<PositionRow>(
      "SELECT * FROM positions WHERE account = ? ORDER BY opened_at",
      account,
    );
  }

  openOrders(account: AccountId): OrderRow[] {
    return this.sql.exec<OrderRow>(
      `SELECT * FROM orders WHERE account = ? AND state IN (${OPEN_SQL}) ORDER BY created_at`,
      account,
    );
  }

  contract(id: string): DecisionContract | null {
    const row = one<{ json: string }>(this.sql, "SELECT json FROM contracts WHERE contract_id = ?", id);
    return row ? (JSON.parse(row.json) as DecisionContract) : null;
  }

  private symbolsInPlay(): string[] {
    const s = new Set<string>();
    for (const a of ACCOUNTS) for (const p of this.positions(a)) s.add(p.symbol);
    return [...s];
  }

  private async quotesFor(symbols: string[]): Promise<Record<string, Quote>> {
    const m = this.deps.market;
    if (!m || symbols.length === 0) return {};
    const crypto = symbols.filter(isCryptoSymbol);
    const stocks = symbols.filter((s) => !isCryptoSymbol(s));
    const [a, b] = await Promise.all([m.cryptoQuotes(crypto), m.stockQuotes(stocks)]);
    return { ...a, ...b };
  }

  status(): StatusView {
    const now = this.deps.now();
    const last = getKV(this.sql, "last_pulse_at");
    return {
      now,
      lastPulseAt: last ? Number(last) : null,
      budget: this.budget.snapshot(now),
      journalHead: this.journal.head(),
      outboxPending: this.journal.pending(),
      equity: this.equityHistory(now - 7 * 86_400_000),
      regimes: this.sql
        .exec<{
          arena: string;
          posture: string;
          score: number | null;
          ceiling: number | null;
          as_of: number;
          payload_json: string;
        }>("SELECT arena, posture, score, ceiling, as_of, payload_json FROM regime_state ORDER BY arena")
        .map((r) => ({
          arena: r.arena,
          posture: r.posture,
          score: r.score,
          ceiling: r.ceiling,
          ageMinutes: Math.round((now - r.as_of) / 60_000),
          fresh:
            r.arena === "CRYPTO_PROXY" || this.freshRegime(r.arena as "CRYPTO" | "EQUITIES", now) !== null,
          source: (JSON.parse(r.payload_json) as { source?: string }).source ?? "?",
        })),
      accounts: ACCOUNTS.flatMap((account) => {
        const row = this.account(account);
        if (!row) return [];
        const eq = this.effectiveEquityCents(row);
        const stopCoids = new Set(
          this.openOrders(account)
            .filter((o) => o.role === "STOP")
            .map((o) => o.client_order_id),
        );
        return [
          {
            account,
            configured: Boolean(this.deps.brokers[account]),
            equityUsd: eq === null ? null : eq / 100,
            brokerEquityUsd: row.broker_equity_cents === null ? null : row.broker_equity_cents / 100,
            modeledCostUsd: row.modeled_cost_cents / 100,
            hwmUsd: row.hwm_cents === null ? null : row.hwm_cents / 100,
            rung: row.rung,
            autonomyStop: row.autonomy_stop,
            breaker: row.breaker,
            locked: row.locked === 1,
            mode: row.mode,
            modeReason: row.mode_reason,
            reconciledAt: row.reconciled_at,
            lastError: row.last_error,
            ordersToday: row.orders_today,
            positions: this.positions(account).map((p) => ({
              symbol: p.symbol,
              qty: p.qty,
              avgEntry: p.avg_entry,
              stop: p.stop_price,
              target: p.target_price,
              state: p.state,
              brokerStop: p.broker_stop_coid !== null && stopCoids.has(p.broker_stop_coid),
            })),
            openOrders: this.openOrders(account).map((o) => ({
              coid: o.client_order_id,
              role: o.role,
              symbol: o.symbol,
              side: o.side,
              qty: o.qty,
              state: o.state,
            })),
          },
        ];
      }),
    };
  }

  // ------------------------------------------------------------------ operator controls (Discord RPC)

  private setMode(account: AccountId, mode: AccountRow["mode"], reason: string, now: number): void {
    const row = this.account(account);
    if (!row || (row.mode === mode && row.mode_reason === reason)) return;
    this.sql.exec("UPDATE accounts SET mode = ?, mode_reason = ? WHERE account = ?", mode, reason, account);
    this.journal.append(account, "MODE", null, { from: row.mode, to: mode, reason }, now);
  }

  pause(account: AccountId, by: string): string {
    this.setMode(account, "PAUSED", `paused by ${by}`, this.deps.now());
    return `${account} paused (reduce-only).`;
  }

  resume(account: AccountId, by: string): string {
    const row = this.account(account);
    if (row?.locked === 1) {
      return account === "PAPER"
        ? `${account} is RED-locked; it unlocks itself after the cooldown once flat (or /unlock now).`
        : `${account} is RED-locked. Use /unlock with a written postmortem.`;
    }
    this.setMode(account, "NORMAL", `resumed by ${by}`, this.deps.now());
    return `${account} resumed.`;
  }

  setDial(account: AccountId, stop: number, by: string, ratified: boolean): string {
    const now = this.deps.now();
    const allowed = DIAL_STOPS[account];
    if (!allowed.includes(stop)) {
      return `${account} dial must be one of ${allowed.join(", ")} (there is no approve-each-trade mode).`;
    }
    const max = this.c.hard_limits.max_live_autonomy_stop_without_ratification;
    if (account === "LIVE" && stop > max && !ratified)
      return `LIVE above Stop ${max} needs confirm:RATIFY (constitution U8).`;
    this.sql.exec("UPDATE accounts SET autonomy_stop = ? WHERE account = ?", stop, account);
    this.journal.append(account, "DIAL", null, { stop, by, ratified }, now);
    return `${account} autonomy dial → Stop ${stop}.`;
  }

  /**
   * Fresh start for one account (operator, signed admin route only — ADR-038): used after switching to a new
   * broker account. Refuses unless the broker is flat with no open orders. Wipes that account's hot trading
   * state and re-creates its row from the doctrine; the journal is append-only, so it records RESET and keeps
   * its chain (the Governor counts RESET as the start of the autonomous clock).
   */
  async resetAccount(account: AccountId, by: string): Promise<{ ok: boolean; message: string }> {
    const now = this.deps.now();
    const broker = this.deps.brokers[account];
    if (!broker) return { ok: false, message: `${account} has no broker keys` };
    const [positions, orders, acct] = await Promise.all([
      broker.positions(),
      broker.openOrders(),
      broker.account(),
    ]);
    if (positions.length > 0 || orders.length > 0) {
      return {
        ok: false,
        message: `${account} is not flat at the broker (${positions.length} positions, ${orders.length} open orders)`,
      };
    }
    for (const t of [
      "positions",
      "orders",
      "risk_reservations",
      "exits",
      "unsettled",
      "seen_activities",
      "equity_history",
    ]) {
      this.sql.exec(`DELETE FROM ${t} WHERE account = ?`, account);
    }
    this.sql.exec("DELETE FROM cursors WHERE name = ?", `activities:${account}`);
    this.sql.exec("DELETE FROM accounts WHERE account = ?", account);
    const cfg = this.d.accounts[account];
    this.sql.exec(
      "INSERT INTO accounts (account, autonomy_stop, day) VALUES (?, ?, ?)",
      account,
      cfg?.autonomy_stop ?? 0,
      utcDay(now),
    );
    this.sql.exec("DELETE FROM settings WHERE key IN ('equity_hour', 'day_pulses', 'day_max_gap_s')");
    const equity = Number(acct.equity);
    this.journal.append(
      account,
      "RESET",
      null,
      { by, broker_equity: equity, reason: "fresh start on a new broker account" },
      now,
    );
    await this.flushJournal();
    await this.deps.notifier.post("alarms", {
      content: `🔄 ${account} reset to a fresh start by ${by}: broker equity $${equity.toFixed(2)}, history cleared, 30-day clock restarted.`,
    });
    return { ok: true, message: `${account} reset: broker equity $${equity.toFixed(2)}` };
  }

  unlock(account: AccountId, postmortem: string, by: string): string {
    const now = this.deps.now();
    if (postmortem.trim().length < 50) return "Postmortem must be at least 50 characters.";
    const row = this.account(account);
    if (!row || row.locked === 0) return `${account} is not locked.`;
    const eq = this.effectiveEquityCents(row);
    // A fresh start: high-water mark and day start reset to current equity so the ladder doesn't re-trip at once.
    this.sql.exec(
      "UPDATE accounts SET locked = 0, breaker = 'GREEN', hwm_cents = ?, day_start_equity_cents = ?, autonomy_stop = CASE WHEN account = 'LIVE' THEN 0 ELSE autonomy_stop END, mode = 'NORMAL', mode_reason = NULL WHERE account = ?",
      eq,
      eq,
      account,
    );
    this.journal.append(account, "UNLOCK", null, { by, postmortem }, now);
    return account === "LIVE"
      ? `${account} unlocked; dial reset to Stop 0 (needs RATIFY to trade again). Postmortem journaled.`
      : `${account} unlocked. Postmortem journaled.`;
  }

  async flatten(account: AccountId, why: string, brokerOverride?: BrokerApi): Promise<string> {
    const broker = brokerOverride ?? this.deps.brokers[account];
    if (!broker) return `${account} is not configured.`;
    const now = this.deps.now();
    this.setMode(account, "REDUCE_ONLY", `flatten: ${why}`, now);
    await this.cancelEntries(account, broker, why);
    const quotes = await this.quotesFor(this.positions(account).map((p) => p.symbol)).catch(
      () => ({}) as Record<string, Quote>,
    );
    let n = 0;
    for (const pos of this.positions(account))
      if (await this.exitPosition(account, broker, pos, `FLATTEN: ${why}`, quotes[pos.symbol] ?? null)) n++;
    this.journal.append(account, "FLATTEN", null, { why, exits_submitted: n }, now);
    await this.deps.notifier.post("alarms", {
      embeds: [
        {
          title: `🛑 ${account} flatten`,
          color: COLORS.red,
          description: `${why} · ${n} exit order(s) submitted`,
        },
      ],
    });
    return `${account}: flatten started (${n} exit orders). Mode REDUCE_ONLY until /resume.`;
  }

  noteKill(killed: boolean): void {
    const now = this.deps.now();
    const prev = getKV(this.sql, "kill_seen");
    const next = killed ? "1" : "0";
    if (prev === next) return;
    setKV(this.sql, "kill_seen", next, now);
    // Journal transitions so kill drills are provable from the record (first observation of "clear" is silent).
    if (killed || prev === "1")
      this.journal.append("SYSTEM", killed ? "KILL_SEEN" : "KILL_CLEARED", null, {}, now);
  }

  // ------------------------------------------------------------------ persistence & telemetry

  async flushJournal(): Promise<number> {
    if (!this.deps.d1) return 0;
    const now = this.deps.now();
    let total = 0;
    try {
      for (let i = 0; i < 3 && this.journal.pending() > 0; i++)
        total += await this.journal.flush(this.deps.d1, 14);
      this.budget.add("d1_rows_written", total, now);
    } catch (e) {
      const msg = errText(e);
      if (/limit|exceeded|quota/i.test(msg)) this.budget.markLimitHit("d1", now);
      await this.alertOnce("d1-flush", `⚠️ D1 flush failed (rows kept in outbox): ${msg.slice(0, 200)}`);
    }
    return total;
  }

  private async alertOnce(key: string, text: string): Promise<void> {
    const now = this.deps.now();
    const last = Number(getKV(this.sql, `alert:${key}`) ?? 0);
    if (now - last < 3_600_000) return;
    setKV(this.sql, `alert:${key}`, String(now), now);
    this.journal.append("SYSTEM", "ALERT", key, { text }, now);
    await this.deps.notifier.post("alarms", { content: text.slice(0, 1900) });
  }

  /** One equity sample per account per UTC hour (HUD chart, web terminal). */
  private sampleEquity(now: number): void {
    const hour = Math.floor(now / 3_600_000);
    if (getKV(this.sql, "equity_hour") === String(hour)) return;
    for (const row of this.sql.exec<AccountRow>("SELECT * FROM accounts")) {
      const eq = this.effectiveEquityCents(row);
      if (eq === null) continue;
      this.sql.exec(
        "INSERT OR REPLACE INTO equity_history (account, at, equity_cents) VALUES (?, ?, ?)",
        row.account,
        hour * 3_600_000,
        eq,
      );
    }
    setKV(this.sql, "equity_hour", String(hour), now);
  }

  equityHistory(since: number): Partial<Record<AccountId, number[][]>> {
    const out: Partial<Record<AccountId, number[][]>> = {};
    for (const r of this.sql.exec<{ account: AccountId; at: number; equity_cents: number }>(
      "SELECT account, at, equity_cents FROM equity_history WHERE at >= ? ORDER BY at",
      since,
    )) {
      const list = out[r.account] ?? [];
      list.push([r.at, r.equity_cents / 100]);
      out[r.account] = list;
    }
    return out;
  }

  private async flushTerminal(): Promise<void> {
    if (this.termBuffer.length === 0) return;
    const lines = this.termBuffer.splice(0, this.termBuffer.length);
    await this.deps.notifier.post("terminal", { content: lines.join("\n").slice(0, 1900) });
  }

  /** Single-use check for web-terminal login links (ADR-034). */
  consumeOnce(id: string): boolean {
    return this.markSeen(`web:${id}`, this.deps.now());
  }

  /** Memory Vault view: decayed beliefs, reputation weights, merged scar rules. */
  memoryView(): {
    beliefs: { subject: string; statement: string; confidence: number }[];
    reputation: Record<string, { weight: number; signals: number }>;
    scars: { id: string; kind: string; rule: string; expires: string | null }[];
  } {
    const now = this.deps.now();
    const beliefs = this.sql
      .exec<{ subject: string; statement: string; c0: number; half_life_days: number; validated_at: number }>(
        "SELECT subject, statement, c0, half_life_days, validated_at FROM beliefs WHERE status != 'ARCHIVED'",
      )
      .map((b) => ({
        subject: b.subject,
        statement: b.statement,
        confidence: Number(
          (b.c0 * 0.5 ** ((now - b.validated_at) / 86_400_000 / b.half_life_days)).toFixed(3),
        ),
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 100);
    let reputation: Record<string, { weight: number; signals: number }> = {};
    try {
      reputation = JSON.parse(getKV(this.sql, "reputation") ?? "{}");
    } catch {
      reputation = {};
    }
    const scars = this.scarRules().map((r) => ({
      id: r.id,
      kind: r.kind,
      rule: r.rule,
      expires: r.expires ?? null,
    }));
    return { beliefs, reputation, scars };
  }

  private async updateHud(): Promise<void> {
    const now = this.deps.now();
    const last = Number(getKV(this.sql, "hud:last_at") ?? 0);
    if (now - last < this.d.cadence.hud_min_edit_interval_seconds * 1000) return;
    setKV(this.sql, "hud:last_at", String(now), now);
    const msg = hudMessage(this.status());
    const id = getKV(this.sql, "hud:message_id");
    if (id && (await this.deps.notifier.edit("command_center", id, msg))) return;
    const created = await this.deps.notifier.post("command_center", msg);
    if (created) setKV(this.sql, "hud:message_id", created, now);
  }
}

// ---------------------------------------------------------------------- helpers

/** An equity earnings calendar older than this blocks equity entries (fail closed, ADR-035). */
const EARNINGS_CALENDAR_MAX_AGE_MS = 4 * 86_400_000;

const TERMINAL_KINDS: Record<string, string> = {
  ENTRY_FACTS: "🎯",
  ORDER_SUBMITTED: "📨",
  FILL: "💱",
  EXIT: "🏁",
  RED_LOCK: "🛑",
  UNLOCK: "🔓",
  MODE: "⚙️",
  DIAL: "🎚️",
  FLATTEN: "🧹",
  KILL_SEEN: "☠️",
  KILL_CLEARED: "✅",
  COURT: "⚖️",
  DISPATCH: "📤",
  GOVERNOR: "🧬",
  OPTIONS_LAB: "🧪",
  INGEST_REJECTED: "⚠️",
  DAY_ROLL: "🔗",
};

/** One compact line per notable journal event for #agent-terminal; null for the rest. */
export function terminalLine(r: {
  ts: number;
  account: string;
  kind: string;
  refId: string | null;
  payloadJson: string;
}): string | null {
  const icon = TERMINAL_KINDS[r.kind];
  if (!icon) return null;
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(r.payloadJson) as Record<string, unknown>;
  } catch {
    p = {};
  }
  const f = (p.facts ?? {}) as Record<string, unknown>;
  const detail =
    r.kind === "ENTRY_FACTS"
      ? `${f.symbol ?? ""} ${f.strategy_id ?? ""} w=${p.reputation_weight ?? 1}`
      : r.kind === "DISPATCH"
        ? String(p.job ?? "")
        : r.kind === "EXIT"
          ? `${p.symbol ?? ""} ${p.reason ?? ""} ${typeof p.pnl_cents === "number" ? `$${(p.pnl_cents / 100).toFixed(2)}` : ""}`
          : r.kind === "FILL"
            ? `${p.role ?? ""} ${p.qty ?? ""} @ ${p.price ?? ""}`
            : JSON.stringify(p).slice(0, 120);
  const hhmm = new Date(r.ts).toISOString().slice(11, 16);
  const acct = r.account === "SYSTEM" ? "" : ` ${r.account}`;
  return `\`${hhmm}\` ${icon} ${r.kind}${acct} ${detail}`.slice(0, 200);
}

/** QuickChart line image for the HUD (rendered off-platform: zero Worker CPU). */
export function equityChartUrl(points: number[][] | undefined): string | null {
  if (!points || points.length < 2) return null;
  const pts = points.slice(-72);
  const cfg = {
    type: "line",
    data: {
      labels: pts.map(() => ""),
      datasets: [
        { data: pts.map((p) => p[1]), fill: false, pointRadius: 0, borderColor: "#38bdf8", borderWidth: 2 },
      ],
    },
    options: { legend: { display: false }, scales: { xAxes: [{ display: false }] } },
  };
  return `https://quickchart.io/chart?w=500&h=140&bkg=%23111827&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Add business days (Mon–Fri). Holidays aren't modeled, which is why callers add a day of buffer. */
export function addBusinessDays(ts: number, days: number): number {
  let t = ts;
  let left = days;
  while (left > 0) {
    t += 86_400_000;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return t;
}

const bandColor = (b: Band) =>
  b === "GREEN" ? COLORS.green : b === "YELLOW" ? COLORS.yellow : b === "ORANGE" ? COLORS.orange : COLORS.red;
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

export function hudMessage(s: StatusView): DiscordMessage {
  const age = s.lastPulseAt === null ? "never" : `${Math.round((s.now - s.lastPulseAt) / 1000)}s ago`;
  const embeds = s.accounts.map((a) => ({
    ...(equityChartUrl(s.equity[a.account])
      ? { image: { url: equityChartUrl(s.equity[a.account]) as string } }
      : {}),
    title: `${a.account} · ${a.rung} · Stop ${a.autonomyStop} · ${a.breaker}${a.locked ? " 🔒" : ""}`,
    color: bandColor(a.breaker),
    description: a.configured
      ? `mode **${a.mode}**${a.modeReason ? ` (${a.modeReason})` : ""}`
      : "_not configured_",
    fields: [
      {
        name: "Equity",
        value: `${usd(a.equityUsd)}${a.account === "PAPER" ? ` (broker ${usd(a.brokerEquityUsd)}, modeled costs ${usd(a.modeledCostUsd)})` : ""}`,
        inline: false,
      },
      { name: "HWM", value: usd(a.hwmUsd), inline: true },
      { name: "Orders today", value: String(a.ordersToday), inline: true },
      {
        name: `Positions (${a.positions.length})`,
        value:
          a.positions.length === 0
            ? "flat"
            : a.positions
                .map(
                  (p) =>
                    `${p.symbol} ${p.qty} @ ${p.avgEntry} · stop ${p.stop}${p.brokerStop ? " 🛡" : " ⚠️"} · tgt ${p.target}${p.state === "EXITING" ? " · exiting" : ""}`,
                )
                .join("\n")
                .slice(0, 1000),
        inline: false,
      },
    ],
  }));
  const regimeLine = s.regimes
    .map(
      (r) =>
        `${r.arena} **${r.posture}**${r.score !== null ? ` ${r.score.toFixed(0)}` : ""}${r.ceiling !== null ? ` · ceiling ${(r.ceiling * 100).toFixed(0)}%` : ""} · ${r.ageMinutes}m${r.fresh ? "" : " ⚠️stale"}`,
    )
    .join("  |  ");
  const paper = s.accounts.find((a) => a.account === "PAPER" && a.configured);
  const components: DiscordMessage["components"] = paper
    ? [
        {
          type: 1,
          components: [
            paper.mode === "PAUSED"
              ? { type: 2, style: 3, label: "Resume PAPER entries", custom_id: "resume:PAPER" }
              : { type: 2, style: 2, label: "Pause PAPER entries", custom_id: "pause:PAPER" },
            { type: 2, style: 4, label: "Flatten PAPER…", custom_id: "flatten:PAPER" },
          ],
        },
      ]
    : [];
  return {
    components,
    content:
      `🧠 **CORTEX-54** · pulse ${age} · budget **${s.budget.mode}** (${s.budget.worst.resource} ${(s.budget.worst.fraction * 100).toFixed(0)}%) · journal #${s.journalHead.seq}${s.outboxPending > 0 ? ` (${s.outboxPending} unflushed)` : ""}` +
      (regimeLine ? `\n🌐 ${regimeLine}` : ""),
    embeds,
  };
}

/** Informational contract card for #court. No buttons: execution never waits on a human (ADR-024). */
export function contractCard(k: DecisionContract): DiscordMessage {
  return {
    embeds: [
      {
        title: `⚖️ ${k.symbol} · ${k.strategy_id} · ${k.origin}`,
        color: COLORS.cyan,
        description: k.thesis_summary,
        fields: [
          { name: "Entry zone", value: `${k.entry_plan.zone_low} – ${k.entry_plan.zone_high}`, inline: true },
          { name: "Stop", value: k.invalidation_criteria.stop_price, inline: true },
          { name: "Target", value: k.entry_plan.targets.join(" / "), inline: true },
          { name: "Bear case", value: k.bear_case_brief.slice(0, 1000), inline: false },
        ],
        footer: { text: `contract ${k.contract_id}` },
      },
    ],
  };
}

const postureColor = (p: string) =>
  p === "NEW_ENTRY_ALLOWED" ? COLORS.green : p === "REDUCE_ONLY" ? COLORS.yellow : COLORS.red;

/** Posture card for #pulse-and-briefs (crypto every 4 h, equities pre-open/post-close). */
export function postureCard(b: Batch, previous: string | null): DiscordMessage {
  const p = b.posture;
  if (!p) return { content: `${b.job}: ${b.items.length} item(s)` };
  const changed = previous !== null && previous !== p.posture ? ` (was ${previous})` : "";
  return {
    embeds: [
      {
        title: `${p.arena === "CRYPTO" ? "🪙 Crypto regime" : "📊 Equity posture"} · ${p.posture}${changed}`,
        color: postureColor(p.posture),
        description: p.summary,
        fields: [
          { name: "Score", value: `${p.score.toFixed(1)} / 100`, inline: true },
          {
            name: "Exposure ceiling",
            value: p.ceiling === null ? "—" : `${(p.ceiling * 100).toFixed(0)}%`,
            inline: true,
          },
          { name: "Confidence", value: p.confidence ?? "—", inline: true },
          ...b.items.slice(0, 6).map((i) => ({
            name: i.skill_id,
            value: String((i.payload as { headline?: unknown }).headline ?? "ok").slice(0, 200),
            inline: false,
          })),
        ],
        footer: {
          text: `${b.job} · produced ${new Date(b.produced_at).toISOString()}${b.run_url ? " · GitHub Actions" : ""}`,
        },
        timestamp: new Date(b.produced_at).toISOString(),
      },
    ],
  };
}

/** #world-intel card for a Tier 1 promotion. */
export function intelCard(
  it: TriageItem,
  d: { material: number; direction: string; escalate: number },
  payload: Record<string, unknown>,
): DiscordMessage {
  const arrow = d.direction === "up" ? "📈" : d.direction === "down" ? "📉" : "↔️";
  const url = typeof payload.url === "string" && payload.url.startsWith("https://") ? payload.url : null;
  return {
    embeds: [
      {
        title: `${arrow} ${it.symbols.slice(0, 4).join(", ") || it.kind} · P(material) ${d.material.toFixed(2)} · priority ${d.escalate.toFixed(1)}/3`,
        color: d.direction === "up" ? COLORS.green : d.direction === "down" ? COLORS.red : COLORS.cyan,
        description: `${it.headline.slice(0, 300)}${url ? `\n${url}` : ""}`,
        footer: {
          text: `${it.kind} · ${it.source} · ${it.ageMinutes}m old · Tier 1 clef-flash → Tier 2 queue`,
        },
      },
    ],
  };
}

export interface CourtSession {
  symbol: string;
  arena: string;
  catalyst: { headline: string; source: string; url: string | null; kind: string };
  bid: number;
  atr: number;
  facts?: Record<string, string | number> | null;
  kronos?: string | null;
  bull?: {
    thesis: string;
    setup?: string;
    entry_low: number;
    entry_high: number;
    stop: number;
    targets: number[];
    conviction: number;
    horizon_hours: number;
    receipts?: string[];
    by: string;
  };
  bear?: { fatal_flaws: string[]; kill_criteria: string[]; lethality: number; brief?: string; by: string };
  rebuttal?: {
    rebuttal: string;
    concessions: string[];
    still_long: boolean;
    revised_conviction: number;
    by: string;
  };
  panel?: SeatOpinion[];
  synth?: {
    winProb: number;
    calibrated: number;
    bearLethality: number;
    regimeFit: number;
    suitability100: number;
  };
  contractId?: string;
  verdict?: string;
  ok?: boolean;
}

const bar = (p: number) =>
  `${"█".repeat(Math.round(p * 10))}${"░".repeat(10 - Math.round(p * 10))} ${(p * 100).toFixed(0)}%`;
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const model = (by: string) => `\`${by.split("/").slice(1).join("/") || by}\``;
const STANCE: Record<string, string> = { support: "🟢 SUPPORT", oppose: "🔴 OPPOSE", abstain: "⚪ ABSTAIN" };

/**
 * #bull-vs-bear-court transcript (ADR-044): one message, one embed per stage of the hearing — the docket, the bull's
 * opening, the bear's cross-examination, the bull's rebuttal, the expert panel and the ruling. Kept under Discord's
 * 6,000-character message limit by trimming the longest fields first.
 */
export function courtSessionCard(s: CourtSession): DiscordMessage {
  type Field = { name: string; value: string; inline?: boolean };
  type E = {
    title: string;
    description?: string;
    color: number;
    fields?: Field[];
    footer?: { text: string };
  };
  const embeds: E[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const docket: Field[] = [
    {
      name: "Market",
      value: `bid **${s.bid}**\nATR14 ${s.atr.toPrecision(4)} (${pct(s.atr / s.bid)})`,
      inline: true,
    },
    { name: "Source", value: `${s.catalyst.kind} · ${cut(s.catalyst.source, 40)}`, inline: true },
  ];
  const facts = Object.entries(s.facts ?? {});
  if (facts.length > 0)
    docket.push({
      name: "🔎 Facts on the record (Clairic)",
      value: facts.map(([k, v]) => `\`${k}\` ${v}`).join(" · "),
    });
  if (s.kronos) docket.push({ name: "🔮 Kronos (low confidence)", value: cut(s.kronos, 300) });
  embeds.push({
    title: `⚖️ CORTEX COURT — ${s.symbol} (${s.arena})`,
    description: `**Matter before the court**\n> ${cut(s.catalyst.headline, 300)}${s.catalyst.url ? `\n[source](${s.catalyst.url})` : ""}`,
    color: COLORS.cyan,
    fields: docket,
  });

  if (s.bull) {
    const b = s.bull;
    const rr = (b.targets[0] ?? b.entry_high) - b.entry_high;
    const risk = b.entry_low - b.stop;
    embeds.push({
      title: `🐂 Opening statement — Bull Advocate`,
      description: cut(b.thesis, 700),
      color: COLORS.green,
      fields: [
        {
          name: "Proposed trade",
          value: `entry ${b.entry_low}–${b.entry_high}\nstop ${b.stop}\ntargets ${b.targets.join(" / ")}`,
          inline: true,
        },
        {
          name: "Terms",
          value: `${b.setup ?? "—"} · ${b.horizon_hours}h\nreward:risk ${risk > 0 ? (rr / risk).toFixed(2) : "—"}\nconviction ${b.conviction}/10`,
          inline: true,
        },
        ...(b.receipts?.length
          ? [{ name: "Exhibits", value: cut(b.receipts.map((r) => `\`${r}\``).join(" "), 300) }]
          : []),
      ],
      footer: { text: `argued by ${b.by}` },
    });
  }
  if (s.bear) {
    embeds.push({
      title: `🐻 Cross-examination — Bear Prosecutor · lethality ${(s.bear.lethality * 100).toFixed(0)}%`,
      description: s.bear.fatal_flaws
        .slice(0, 4)
        .map((f, i) => `**${i + 1}.** ${cut(f, 260)}`)
        .join("\n"),
      color: COLORS.red,
      fields: [
        {
          name: "The bull is wrong if…",
          value: cut(
            s.bear.kill_criteria
              .slice(0, 3)
              .map((k) => `• ${k}`)
              .join("\n"),
            600,
          ),
        },
      ],
      footer: { text: `prosecuted by ${s.bear.by}` },
    });
  }
  if (s.rebuttal) {
    const r = s.rebuttal;
    embeds.push({
      title: `🐂 Rebuttal — ${r.still_long ? "the bull stands firm" : "the bull withdraws"}`,
      description: cut(r.rebuttal, 900),
      color: r.still_long ? COLORS.green : COLORS.orange,
      fields: [
        ...(r.concessions.length
          ? [
              {
                name: "Conceded",
                value: cut(
                  r.concessions
                    .slice(0, 3)
                    .map((c) => `• ${c}`)
                    .join("\n"),
                  500,
                ),
              },
            ]
          : []),
        {
          name: "Conviction after cross",
          value: `${s.bull?.conviction ?? "?"} → **${r.revised_conviction}**/10`,
          inline: true,
        },
      ],
      footer: { text: `answered by ${r.by}` },
    });
  }
  if (s.panel && s.panel.length > 0) {
    const tally = (k: string) => s.panel?.filter((p) => p.stance === k).length ?? 0;
    embeds.push({
      title: `🎓 Expert panel — ${tally("support")} for · ${tally("oppose")} against · ${tally("abstain")} abstain`,
      color: COLORS.yellow,
      fields: s.panel.map((p) => ({
        name: `${p.emoji} ${p.title} — ${STANCE[p.stance] ?? p.stance} (${(p.confidence * 100).toFixed(0)}%)`,
        value: cut(`*${p.headline}*\n${p.points.map((x) => `• ${x}`).join("\n")}\n— ${model(p.by)}`, 1000),
      })),
    });
  }
  const ruling: Field[] = [];
  if (s.synth)
    ruling.push({
      name: "Clef 27B, presiding",
      value: [
        `\`P(win) raw   ${bar(s.synth.winProb)}\``,
        `\`P(win) calib ${bar(s.synth.calibrated)}\``,
        `\`Bear right   ${bar(s.synth.bearLethality)}\``,
        `\`Regime fit   ${bar(s.synth.regimeFit)}\``,
        `\`Suitability  ${bar(s.synth.suitability100 / 100)}\``,
      ].join("\n"),
    });
  ruling.push({ name: "Judgment of the risk engine", value: cut(s.verdict ?? "—", 1000) });
  embeds.push({
    title: s.ok ? "🔨 RULING — trade approved" : "🔨 RULING — no trade",
    color: s.ok ? COLORS.green : s.synth ? COLORS.yellow : COLORS.red,
    fields: ruling,
    footer: {
      text: `${s.contractId ? `contract ${s.contractId}` : "no contract"} · models argue, code computes, the risk engine decides`,
    },
  });

  // Discord: ≤ 1024 per field value, ≤ 4096 per description, ≤ 6000 characters per message.
  for (const e of embeds) for (const f of e.fields ?? []) f.value = cut(f.value, 1024);
  const size = () =>
    embeds.reduce(
      (n, e) =>
        n +
        e.title.length +
        (e.description?.length ?? 0) +
        (e.footer?.text.length ?? 0) +
        (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0),
      0,
    );
  while (size() > 5800) {
    let longest: { get: () => string; set: (v: string) => void } | null = null;
    let len = 0;
    for (const e of embeds) {
      if ((e.description?.length ?? 0) > len) {
        len = e.description?.length ?? 0;
        longest = { get: () => e.description ?? "", set: (v) => (e.description = v) };
      }
      for (const f of e.fields ?? [])
        if (f.value.length > len) {
          len = f.value.length;
          longest = { get: () => f.value, set: (v) => (f.value = v) };
        }
    }
    if (!longest || len < 80) break;
    longest.set(cut(longest.get(), Math.floor(len * 0.8)));
  }
  return { embeds };
}
