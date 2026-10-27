import {
  type AlpacaAsset,
  type BrokerApi,
  BrokerError,
  type MarketDataApi,
  type Quote,
} from "../broker/types.ts";
import {
  type BudgetScope,
  DO_MEMORY_GB,
  FreeTierBudget,
  SubrequestBudgetExceeded,
  utcDay,
} from "../budget/FreeTierBudget.ts";
import { CLEF_CONTEXT_TOKENS, type ClefApi, type ClefResult, estimateTokens } from "../clef/ClefClient.ts";
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
  BacktestPayloadSchema,
  type Batch,
  BatchSchema,
  BeliefSchema,
  type Dossier,
  DossierPayloadSchema,
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
  uncitedNumbers,
} from "../court/court.ts";
import {
  buildEvidence,
  type Evidence,
  evidenceForModels,
  KRONOS_ABOUT,
  researchView,
} from "../court/evidence.ts";
import type { HopAttempt, LlmRouter } from "../court/llm.ts";
import {
  BEAR_PERSONAS,
  BEAR_PROMPT_VERSION,
  BEAR_SCHEMA,
  BULL_PROMPT_VERSION,
  BULL_SCHEMA,
  BULL_SYSTEM,
  bearSystem,
  PANEL_PROMPT_VERSION,
  PANEL_SCHEMA,
  PANEL_SEATS,
  panelSystem,
  REBUTTAL_PROMPT_VERSION,
  REBUTTAL_SCHEMA,
  REBUTTAL_SYSTEM,
} from "../court/prompts.ts";
import { COLORS, type Notifier } from "../discord/notifier.ts";
import { fetchFeed, type HubConfig, publishBatch } from "../hub/client.ts";
import { PUBLIC_KINDS } from "../hub/protocol.ts";
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
import { weekdayMsBetween } from "../lib/time.ts";
import { type BookLine, type BookSummary, beta, summarizeBook, worstWindow } from "../portfolio/book.ts";
import {
  buildReview,
  type ExitState,
  excursions,
  holdOrHarvest,
  interpretReview,
  REVIEW_PROMPT_VERSION,
  ratchetStop,
  rMultiple,
  stagnant,
  tightenedStop,
  tripwires,
} from "../portfolio/exits.ts";
import { lateness } from "../portfolio/lateness.ts";
import { type Band, evaluateBreaker, withHysteresis } from "../risk/CircuitBreakerLadder.ts";
import { correlation, correlationVeto } from "../risk/correlation.ts";
import { type Arena, modeledPaperCostCents, roundTripFeeRate } from "../risk/fees.ts";
import { type AccountView, type AssetView, validateEntry } from "../risk/PreTradeValidator.ts";
import { effectiveRung, type RungName } from "../risk/rungs.ts";
import { coinbaseProduct, depegBps, haltedSymbols, venueGapPct } from "../risk/sanity.ts";
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
import { atr, type Bar, ema, rsi } from "../strategy/indicators.ts";
import {
  KRONOS_ID,
  type KronosForecast,
  KronosPayloadSchema,
  kronosParams,
  kronosSignal,
} from "../strategy/KronosForecast.ts";
import { prefilter } from "../universe/prefilter.ts";
import { normalizeSymbol, screenAsset } from "../universe/screen.ts";
import { Universe } from "../universe/Universe.ts";
import {
  addBusinessDays,
  benchmarkLines,
  bookCard,
  type CourtSession,
  contractCard,
  courtSessionCard,
  dossierCard,
  errText,
  hudMessage,
  intelCard,
  postureCard,
  reviewCard,
  terminalLine,
} from "./cards.ts";
import { dueJobs, type WorkflowDispatcher } from "./dispatch.ts";
import { getKV, one, type SqlLike, type SqlValue, setKV } from "./store.ts";

// the cards used to live here; existing importers keep working
export {
  addBusinessDays,
  benchmarkLines,
  bookCard,
  type CourtSession,
  contractCard,
  courtSessionCard,
  dossierCard,
  equityChartUrl,
  hudMessage,
  intelCard,
  postureCard,
  reviewCard,
  terminalLine,
} from "./cards.ts";

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

type WatchRow = {
  account: AccountId;
  symbol: string;
  contract_id: string;
  initial_stop: number;
  mfe: number;
  mae: number;
  trailing: number;
  regime_open_at_entry: number | null;
  extended_until: number | null;
  last_review_at: number | null;
  reviews: number;
  last_tripwires: string | null;
  pending_headline: string | null;
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

export interface SloView {
  pulse_age_s: number | null;
  outbox_depth: number;
  outbox_dead: number;
  budget_mode: string;
  budget_worst: { resource: string; fraction: number };
  budget_projected: { resource: string; fraction: number };
  alarm_lost_total: number;
  stage_failures_today: Record<string, number>;
  policy_vacuums_today: Record<string, number>;
  court_waiting: number;
}

/**
 * What the sentinel's kill flag says (audit W1-09). `true` = everything (old bare flag, or any unparseable payload:
 * fail closed); `{accounts}` = only those accounts — a LIVE daily-loss kill no longer stops the PAPER research bed.
 */
export type KillFlag = boolean | { accounts: string[]; id?: string; reason?: string };

/** Parse the KV `killed` value. Unknown shapes are a global kill (fail closed). */
export function parseKillFlag(raw: string | null): KillFlag {
  if (raw === null) return false;
  try {
    const p = JSON.parse(raw) as { accounts?: unknown; at?: unknown; reason?: unknown };
    if (Array.isArray(p.accounts) && p.accounts.length > 0 && p.accounts.every((a) => typeof a === "string"))
      return {
        accounts: p.accounts as string[],
        ...(typeof p.at === "number" ? { id: String(p.at) } : {}),
        ...(typeof p.reason === "string" ? { reason: p.reason.slice(0, 200) } : {}),
      };
  } catch {
    /* bare flag */
  }
  return true;
}

export interface BrainDeps {
  /** ADR-081: what the free-tier meter counts (cloud: everything; local: only the user's Cloudflare AI, or nothing) */
  budgetScope?: BudgetScope;
  /**
   * ADR-081: local mode trades the account the user connected, whatever its size, and measures from where it
   * started. The cloud keeps the doctrine's fail-closed check for an account far bigger than `starting_equity_usd`.
   */
  adoptAccountSize?: boolean;
  sql: SqlLike;
  d: Doctrine;
  c: Constitution;
  brokers: Partial<Record<AccountId, BrokerApi>>;
  market: MarketDataApi | null;
  notifier: Notifier;
  d1: D1Like | null;
  readKillFlag: () => Promise<KillFlag>;
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
  /** ADR-067: plain HTTP for the public sanity sources (Coinbase ticker, Nasdaq halts). Null skips those checks. */
  http?: ((url: string, init?: RequestInit) => Promise<Response>) | null;
  /** ADR-068: community hub (publish a signed track record, follow other agents). Null = off. */
  hub?: HubConfig | null;
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
  /** ADR-075: today's AI model calls per provider against its daily cap (what local mode's gauge shows) */
  modelUse: {
    worst: { provider: string; fraction: number };
    providers: { provider: string; calls: number; cap: number | null }[];
  };
  journalHead: { seq: number; sha: string };
  outboxPending: number;
  /** Hourly equity samples (last 7 days) per account: [epoch ms, USD]. */
  equity: Partial<Record<AccountId, number[][]>>;
  /** MLP0-024: buy-and-hold BTC / SPY with the same starting equity, per account. */
  benchmark?: Partial<Record<AccountId, { btc: number[][]; spy: number[][] }>>;
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
    /** ADR-081: what this account started from (its equity when CORTEX first saw it, or since the last fresh start) */
    startUsd: number;
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
  /** ADR-058: dynamic universe (scout-ported and research-watched symbols beyond the doctrine watchlists) */
  readonly universe: Universe;
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
      try {
        this.noteWhy(r);
        if (deps.hub?.publish && PUBLIC_KINDS.has(r.kind) && r.rowSha256 && r.prevRowSha256)
          deps.sql.exec(
            "INSERT OR IGNORE INTO hub_outbox (seq, row_json) VALUES (?, ?)",
            r.seq,
            JSON.stringify({
              seq: r.seq,
              ts: r.ts,
              account: r.account,
              kind: r.kind,
              ref_id: r.refId,
              payload_json: r.payloadJson,
              prev_row_sha256: r.prevRowSha256,
              row_sha256: r.rowSha256,
            }),
          );
      } catch {
        /* never break an append */
      }
      const line = terminalLine(r);
      if (!line) return;
      this.termBuffer.push(line);
      if (this.termBuffer.length > 40) this.termBuffer.shift();
    };
    this.budget = new FreeTierBudget(deps.sql, deps.d, deps.budgetScope ?? "cloudflare");
    this.universe = new Universe(deps.sql, deps.d, deps.c);
    // Audit W2-06: court providers respect per-provider daily call caps (free-tier RPD with margin).
    if (deps.llm) {
      const key = (p: string) => `llm_calls:${p}:${utcDay(deps.now())}`;
      deps.llm.gate = {
        allow: (p) => {
          const cap = deps.d.llm_routing.daily_call_caps[p];
          return cap === undefined || Number(getKV(deps.sql, key(p)) ?? 0) < cap;
        },
        used: (p) => setKV(deps.sql, key(p), String(Number(getKV(deps.sql, key(p)) ?? 0) + 1), deps.now()),
        // ADR-075: per-provider tokens per UTC day, for the paid-model cost meter and its daily spend cap
        tokens: (p, input, output) => {
          const k = `llm_tokens:${p}:${utcDay(deps.now())}`;
          const [i, o] = (getKV(deps.sql, k) ?? "0,0").split(",").map(Number);
          setKV(deps.sql, k, `${(i || 0) + input},${(o || 0) + output}`, deps.now());
        },
        tokensToday: (p) => {
          const [i, o] = (getKV(deps.sql, `llm_tokens:${p}:${utcDay(deps.now())}`) ?? "0,0")
            .split(",")
            .map(Number);
          return { input: i || 0, output: o || 0 };
        },
      };
    }
  }

  // ------------------------------------------------------------------ /why memory (MLP0-011)

  /** Per-symbol decision trail for `/why`, captured from the journal itself (no model, nothing invented). */
  private noteWhy(r: { ts: number; account: string; kind: string; payloadJson: string }): void {
    if (!WHY_KINDS.has(r.kind)) return;
    const p = JSON.parse(r.payloadJson) as Record<string, unknown>;
    const facts = (p.facts ?? {}) as Record<string, unknown>;
    const symbol = String(p.symbol ?? facts.symbol ?? p.out ?? "");
    if (!symbol) return;
    const reasons = Array.isArray(p.reasons) ? (p.reasons as unknown[]).join("; ") : "";
    const detail = [
      p.stage,
      p.reason,
      p.action,
      p.why,
      reasons,
      p.strategy,
      p.from !== undefined ? `${p.from}→${p.to}` : null,
      p.in ? `for ${p.in}` : null,
      typeof p.pnl_cents === "number" ? `P&L $${(p.pnl_cents / 100).toFixed(2)}` : null,
      typeof p.win_cal === "number" ? `win ${Math.round(p.win_cal * 100)}%` : null,
    ]
      .filter((x) => x !== null && x !== undefined && x !== "")
      .map(String)
      .join(" · ")
      .slice(0, 220);
    const key = `why:${symbol}`;
    let list: { at: number; acct: string; kind: string; detail: string }[] = [];
    try {
      list = JSON.parse(getKV(this.sql, key) ?? "[]");
    } catch {
      list = [];
    }
    list.push({ at: r.ts, acct: r.account, kind: r.kind, detail });
    setKV(this.sql, key, JSON.stringify(list.slice(-8)), r.ts);
  }

  /** `/why SYMBOL`: what the system did about a symbol and why, straight from the hot state and the journal trail. */
  why(symbolInput: string): string {
    const now = this.deps.now();
    const sym =
      this.universe.resolve([symbolInput], now)?.symbol ??
      normalizeSymbol(symbolInput)?.symbol ??
      symbolInput.toUpperCase();
    const lines: string[] = [`**${sym}**`];
    for (const a of ACCOUNTS) {
      const pos = this.positions(a).find((x) => x.symbol === sym);
      if (!pos) continue;
      const k = this.contract(pos.contract_id);
      const w = one<WatchRow>(
        this.sql,
        "SELECT * FROM position_watch WHERE account = ? AND symbol = ?",
        a,
        sym,
      );
      const st = w ? this.exitState(pos, w) : null;
      lines.push(
        `📌 ${a} holds it: entry ${pos.avg_entry}, stop ${pos.stop_price}${st ? ` (initial ${st.initialStop})` : ""}, target ${pos.target_price}, opened ${new Date(pos.opened_at).toISOString().slice(0, 16)}Z${w?.trailing ? ", trailing past target" : ""}${w?.reviews ? `, ${w.reviews} review(s)` : ""}`,
      );
      if (k)
        lines.push(
          `   why bought: ${k.thesis_summary} (${k.strategy_id}, win used ${Math.round(k.win_prob_used * 100)}%)`,
        );
    }
    const resting = this.sql.exec<{ account: string; until_at: number; why: string }>(
      "SELECT account, until_at, why FROM resting WHERE symbol = ?",
      sym,
    );
    for (const r of resting)
      lines.push(
        `⏳ ${r.account} resting until ${new Date(r.until_at).toISOString().slice(5, 16)}Z (${r.why})`,
      );
    const u = this.universe.row(sym);
    if (u && u.expires_at > now)
      lines.push(`🌐 universe: ${u.status} via ${u.source} (${u.reason.slice(0, 120)})`);
    let trail: { at: number; acct: string; kind: string; detail: string }[] = [];
    try {
      trail = JSON.parse(getKV(this.sql, `why:${sym}`) ?? "[]");
    } catch {
      trail = [];
    }
    if (trail.length) {
      lines.push("Recent decisions:");
      for (const t of trail.slice(-8))
        lines.push(
          `• ${new Date(t.at).toISOString().slice(5, 16)}Z ${t.kind}${t.acct === "SYSTEM" ? "" : ` ${t.acct}`}: ${t.detail}`,
        );
    }
    if (lines.length === 1)
      lines.push("Nothing on record in the last two weeks: no position, no contract, no refusal.");
    return lines.join("\n").slice(0, 1900);
  }

  // ------------------------------------------------------------------ setup

  /** Audit W1-03: adopt D1's journal head after a hot-storage reset (call before init). */
  async reanchorJournal(d1Head: () => Promise<{ seq: number; sha: string } | null>): Promise<string> {
    const r = await this.journal.reanchor(d1Head);
    if (r === "adopted")
      this.journal.append("SYSTEM", "REANCHOR", null, { seq: this.journal.head().seq }, this.deps.now());
    return r;
  }

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
    if (typeof bootInfo.doctrine_sha256 === "string")
      setKV(this.sql, "running_doctrine", bootInfo.doctrine_sha256, now);
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
    if (report.kill !== "UNKNOWN")
      this.noteKill(ACCOUNTS.some((a) => this.deps.brokers[a] && this.killedFor(a)));
    const budget = this.budget.snapshot(started);
    report.budgetMode = budget.mode;

    // 1. Sync every configured account with the broker (broker = truth).
    for (const account of ACCOUNTS) {
      const broker = this.deps.brokers[account];
      if (!broker) continue;
      try {
        await this.syncAccount(account, broker);
        if (getKV(this.sql, `sync_fail_streak:${account}`) !== "0")
          setKV(this.sql, `sync_fail_streak:${account}`, "0", started);
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
        // Chaos test 2026-10-26: one 503 is routine (reads already retry); alert from the third failed pulse in a row
        const streak = Number(getKV(this.sql, `sync_fail_streak:${account}`) ?? 0) + 1;
        setKV(this.sql, `sync_fail_streak:${account}`, String(streak), started);
        if (streak >= 3)
          await this.alertOnce(
            `sync:${account}`,
            `⚠️ ${account} broker sync failed ${streak} pulses in a row: ${msg.slice(0, 300)}`,
          );
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
        if (this.killedFor(account)) await this.cancelEntries(account, broker, "KILLED by sentinel");
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

    // 2d'. ADR-059: re-underwrite open positions that hit a tripwire; daily surveillance dossiers. Never blocks trading.
    try {
      await this.reviewPositions(started);
      await this.dispatchWatches(started);
    } catch (e) {
      if (!(e instanceof SubrequestBudgetExceeded)) {
        await this.alertOnce("reviews", `⚠️ position review failed: ${errText(e).slice(0, 200)}`);
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
          () => this.runResting(),
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
    await this.bookReview().catch(() => undefined);
    await this.hubSync(started).catch(() => undefined);
    await this.checkDispatchReceipts(started).catch(() => undefined);

    // 4. Persist, report, schedule.
    await this.sampleEquity(started).catch(() => undefined);
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
  /**
   * Audit W1-08: research batches carry the doctrine hash on `main`. When it differs from what this brain runs for
   * more than 2 h, a merged config change was never deployed (CI's deploy step skips without a Cloudflare token).
   */
  private async checkDeployLag(mainSha: string, now: number): Promise<void> {
    const running = getKV(this.sql, "running_doctrine");
    if (!running || running === mainSha) {
      this.sql.exec("DELETE FROM settings WHERE key = 'deploy_lag_since'");
      return;
    }
    const since = Number(getKV(this.sql, "deploy_lag_since") ?? 0);
    if (!since) {
      setKV(this.sql, "deploy_lag_since", String(now), now);
      return;
    }
    if (now - since > 2 * 3_600_000)
      await this.alertOnce(
        "deploy-lag",
        `🚧 DEPLOY LAGGING: main's doctrine is ${mainSha.slice(0, 12)} but the brain runs ${running.slice(0, 12)} (for ${Math.round((now - since) / 3_600_000)} h). Run pnpm deploy:cortex.`,
      );
  }

  /** Audit W1-07: jobs that always ingest when they succeed; a dispatch with no batch after this long is a failure. */
  private static readonly EXPECTED_BATCH: Record<string, { job: string; within_min: number }> = {
    crypto: { job: "crypto-regime", within_min: 60 },
    "equity-open": { job: "equity-posture", within_min: 60 },
    "equity-close": { job: "equity-posture", within_min: 60 },
    kronos: { job: "kronos", within_min: 90 },
    governor: { job: "governor", within_min: 60 },
    "governor-weekly": { job: "governor", within_min: 90 },
  };

  private async checkDispatchReceipts(now: number): Promise<void> {
    let last: Record<string, number> = {};
    try {
      last = JSON.parse(getKV(this.sql, "dispatch_last") ?? "{}") as Record<string, number>;
    } catch {
      return;
    }
    for (const [key, exp] of Object.entries(Brain.EXPECTED_BATCH)) {
      const slot = last[key];
      if (!slot || now - slot < exp.within_min * 60_000 || now - slot > 24 * 3_600_000) continue;
      const seen = Number(getKV(this.sql, `batch_seen:${exp.job}`) ?? 0);
      if (seen >= slot) continue;
      if (getKV(this.sql, `dispatch_stale:${key}`) === String(slot)) continue; // reported this slot already
      setKV(this.sql, `dispatch_stale:${key}`, String(slot), now);
      this.journal.append("SYSTEM", "DISPATCH_STALE", null, { job: key, slot }, now);
      await this.alertOnce(
        `dispatch-stale:${key}`,
        `⚠️ research job \`${key}\` was dispatched ${Math.round((now - slot) / 60_000)} min ago but no batch arrived. Check the GitHub Actions run.`,
      );
    }
  }

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

  /**
   * Overall kill state for this brain: KILLED only when every configured account is covered by the flag; a flag that
   * names some accounts leaves the others trading (audit W1-09), with entries blocked per account by `killedFor`.
   */
  private async readKill(): Promise<KillState> {
    let flag: KillFlag;
    try {
      flag = await this.deps.readKillFlag();
    } catch {
      return "UNKNOWN";
    }
    const scope = flag === false ? [] : flag === true ? ["ALL"] : flag.accounts;
    setKV(this.sql, "kill_scope", JSON.stringify(scope), this.deps.now());
    setKV(
      this.sql,
      "kill_meta",
      JSON.stringify(typeof flag === "object" ? { id: flag.id ?? null, reason: flag.reason ?? null } : {}),
      this.deps.now(),
    );
    if (flag === false) return "CLEAR";
    const configured = ACCOUNTS.filter((a) => this.deps.brokers[a]);
    return configured.length === 0 || configured.every((a) => this.killedFor(a)) ? "KILLED" : "CLEAR";
  }

  /** True when the current kill flag covers this account. */
  killedFor(account: AccountId): boolean {
    try {
      const scope = JSON.parse(getKV(this.sql, "kill_scope") ?? "[]") as string[];
      return scope.includes("ALL") || scope.includes(account);
    } catch {
      return true;
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
      this.compactHotState(now);
    }
  }

  /**
   * Hot-state retention (audit W1-02): counters, alert stamps and per-day strategy keys used to grow forever. D1
   * keeps the cold copy of contracts and the journal; the hot copies only need to cover what is still open and the
   * recent past. Day/month keys are matched by their date suffix, so long-lived settings are never touched.
   */
  private compactHotState(now: number): void {
    const day = 86_400_000;
    this.sql.exec(
      `DELETE FROM settings WHERE updated_at < ? AND (
         key LIKE 'count:%' OR key LIKE 'alert:%' OR key LIKE 'court_seen:%' OR key LIKE 'spreads:%'
         OR key LIKE 't1_fail:%' OR key LIKE 'dispatch_stale:%' OR key LIKE 'ratify_request:%' OR key LIKE 'why:%'
         OR key LIKE 'watch_dispatched:%' OR key LIKE 'venue:%' OR key LIKE 'review_failed:%'
         OR key GLOB '*:20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR key GLOB '*:month:20[0-9][0-9]-[0-9][0-9]')`,
      now - 14 * day,
    );
    this.sql.exec(
      "DELETE FROM settings WHERE updated_at < ? AND (key LIKE 'act_fail:%' OR key LIKE 'outbox_fail:%')",
      now - 30 * day,
    );
    this.sql.exec(
      `DELETE FROM contracts WHERE created_at < ?
         AND contract_id NOT IN (SELECT contract_id FROM positions)
         AND contract_id NOT IN (SELECT contract_id FROM orders WHERE state IN (${OPEN_SQL}))`,
      now - 180 * day,
    );
    this.sql.exec("DELETE FROM d1_outbox_dead WHERE dead_at < ?", now - 90 * day);
    // ADR-051: dossiers are only used while fresh (≤ 12 h); keep a week for the web terminal and debugging
    this.sql.exec("DELETE FROM dossiers WHERE received_at < ?", now - 7 * day);
    this.sql.exec("DELETE FROM court_waits WHERE until_at < ?", now - day);
    this.sql.exec("DELETE FROM settings WHERE key LIKE 'research_pending:%' AND updated_at < ?", now - day);
    this.universe.compact(now);
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
    // ADR-081: a different broker account behind the same slot (demo → paper, new keys) starts fresh: positions,
    // orders and history from the old one mean nothing here, and mixing them would corrupt P&L and drawdown.
    const idKey = `broker_account_id:${account}`;
    const prevId = getKV(this.sql, idKey);
    if (prevId !== acct.id) {
      if (prevId !== null)
        await this.freshStart(
          account,
          Number(acct.equity),
          `the broker account changed (${prevId === "sim" ? "demo" : "previous account"} → ${acct.id === "sim" ? "demo" : "a new account"})`,
          "auto",
        );
      else if (this.deps.adoptAccountSize && this.staleHistory(account, Number(acct.equity)))
        // first run of this version on a home whose history belongs to another account (an earlier mode switch)
        await this.freshStart(account, Number(acct.equity), "history from a different account", "auto");
      setKV(this.sql, idKey, acct.id, now);
    }
    // Conditions that block entries are re-checked every sync; when they all clear, so does the mode (ADR-025).
    const issues: string[] = [];
    if (acct.multiplier !== undefined && acct.multiplier !== null && Number(acct.multiplier) > 1) {
      // Constitution U3: cash only. A margin multiplier means the broker would let us borrow; we never do. ADR-081:
      // an account whose own configuration caps borrowing at 1x (Settings → "make it cash-only") is cash-only.
      if (!(await this.cashOnlyConfig(account, broker, now)))
        issues.push(
          "the broker account allows margin (multiplier > 1); cash-only doctrine. Fix: SETTINGS → Trading account → Make it cash-only",
        );
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
    // Apply first, mark seen only on success (audit W1-21): a throw used to consume the fill id and lose the money
    // event. A failing activity stops the loop with the cursor before it, so the next pulse retries it; after 3
    // failures it is quarantined loudly instead of blocking every later fill forever.
    for (const act of cursor === null ? [] : activities) {
      const ts = act.transaction_time ?? act.date ?? lastTs;
      if (one(this.sql, "SELECT id FROM seen_activities WHERE id = ?", act.id)) {
        lastTs = ts;
        continue;
      }
      try {
        if (act.activity_type === "FILL") this.applyFill(account, act, now);
        else if (act.activity_type === "CFEE")
          this.journal.append(account, "FEE", act.symbol ?? null, act, now);
      } catch (e) {
        const key = `act_fail:${act.id}`;
        const n = Number(getKV(this.sql, key) ?? 0) + 1;
        setKV(this.sql, key, String(n), now);
        if (n < 3) {
          await this.alertOnce(
            `act-fail:${act.id}`,
            `⚠️ ${account}: could not apply activity ${act.id} (${errText(e).slice(0, 160)}); retrying next pulse.`,
          );
          break;
        }
        this.journal.append(
          account,
          "ACTIVITY_QUARANTINE",
          act.id,
          { activity: act, error: errText(e).slice(0, 300) },
          now,
        );
        await this.alertOnce(
          `act-q:${act.id}`,
          `🚨 ${account}: activity ${act.id} failed 3 times and was quarantined — reconcile by hand.`,
        );
      }
      this.sql.exec("INSERT INTO seen_activities (id, account, at) VALUES (?, ?, ?)", act.id, account, now);
      lastTs = ts;
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
    if ((row?.hwm_cents ?? null) === null) setKV(this.sql, `start_equity:${account}`, String(eff), now);
    if (
      !this.deps.adoptAccountSize &&
      (row?.hwm_cents ?? null) === null &&
      start !== undefined &&
      eff > start * 2 * 100
    ) {
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
      .exec<{ contract_id: string; json: string }>("SELECT contract_id, json FROM contracts")
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
    // Audit W3-15: with the reservation gone, re-derive risk from the contract (qty × distance to its stop); with no
    // contract at all, count the whole notional as risk — over-counting heat blocks entries, under-counting allows
    // too many (fail closed).
    const qtyN = Number(o.qty ?? 0);
    const px = Number(o.limit_price ?? o.stop_price ?? 0);
    const notionalCents = reservation?.notional_cents ?? Math.ceil(qtyN * px * 100);
    let riskCents = reservation?.risk_cents ?? 0;
    if (!reservation && role === "ENTRY") {
      let stop = 0;
      try {
        stop = Number(
          (JSON.parse(contract?.json ?? "{}") as DecisionContract).invalidation_criteria?.stop_price ?? 0,
        );
      } catch {
        stop = 0;
      }
      riskCents = stop > 0 && px > stop ? Math.ceil(qtyN * (px - stop) * 100) : notionalCents;
    }
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
      riskCents,
      notionalCents,
      now,
      now,
    );
    if (contract)
      this.sql.exec(
        "DELETE FROM risk_reservations WHERE contract_id = ? AND account = ?",
        contract.contract_id,
        account,
      );
    this.journal.append(
      account,
      "ORDER_ADOPTED",
      coid,
      { broker_order_id: o.id, status: o.status, risk_cents: riskCents, matched_contract: Boolean(contract) },
      now,
    );
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
    // Audit W2-36/W3-13: realized slippage against the order's own price (positive = worse for us).
    const expected = Number(order.limit_price ?? order.stop_price ?? 0);
    const realizedBps =
      expected > 0
        ? Math.round(((order.side === "buy" ? price - expected : expected - price) / expected) * 10_000)
        : null;
    this.journal.append(
      account,
      "FILL",
      order.client_order_id,
      {
        symbol: order.symbol,
        side: order.side,
        qty,
        price,
        role: order.role,
        fee_cents: feeCents,
        ...(realizedBps === null ? {} : { slip_bps: realizedBps }),
      },
      now,
    );
    // Audit W3-09: a fill far through the order's price is a bad print or a venue problem, never normal.
    if (realizedBps !== null && realizedBps > this.d.execution.exit_collar_bps) {
      this.journal.append(
        account,
        "BAD_PRINT",
        order.client_order_id,
        { symbol: order.symbol, price, expected, bps: realizedBps },
        now,
      );
      void this.alertOnce(
        `bad-print:${order.symbol}`,
        `🧾 ${account}: ${order.symbol} ${order.side} filled ${realizedBps} bps through its order price (${price} vs ${expected}).`,
      );
    }

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
    // ADR-059: what the position could have made and how deep it went, in R (the Governor grades exits from these)
    const w = one<WatchRow>(
      this.sql,
      "SELECT * FROM position_watch WHERE account = ? AND symbol = ? AND contract_id = ?",
      account,
      pos.symbol,
      pos.contract_id,
    );
    if (w) {
      const s = { entry: Number(pos.avg_entry), initialStop: w.initial_stop };
      this.journal.append(
        account,
        "EXCURSIONS",
        pos.contract_id,
        {
          symbol: pos.symbol,
          mfe: w.mfe,
          mae: w.mae,
          mfe_r: Math.round(rMultiple(s, w.mfe) * 100) / 100,
          mae_r: Math.round(rMultiple(s, w.mae) * 100) / 100,
          initial_stop: w.initial_stop,
          final_stop: Number(pos.stop_price),
          trailed: w.trailing === 1,
          reviews: w.reviews,
          held_hours: Math.round(((now - pos.opened_at) / 3_600_000) * 10) / 10,
          reason,
        },
        now,
      );
    }
    this.sql.exec("DELETE FROM position_watch WHERE account = ? AND symbol = ?", account, pos.symbol);
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
      const w = this.watchRow(account, pos, now);
      const fresh = q && now - q.at <= this.d.staleness.quote_seconds * 1000;
      let reason: string | null = pos.state === "EXITING" ? (pos.exit_reason ?? "EXIT") : null;
      if (fresh && w) {
        const ex = excursions(w, q.bid);
        if (ex.mfe !== w.mfe || ex.mae !== w.mae) {
          this.sql.exec(
            "UPDATE position_watch SET mfe = ?, mae = ? WHERE account = ? AND symbol = ?",
            ex.mfe,
            ex.mae,
            account,
            pos.symbol,
          );
          w.mfe = ex.mfe;
          w.mae = ex.mae;
        }
      }
      if (!reason && fresh) {
        if (q.bid <= Number(pos.stop_price)) reason = "STOP_SYNTHETIC";
        else if (q.bid >= Number(pos.target_price) && !(w?.trailing === 1)) {
          // ADR-059 hold-or-harvest: momentum intact → the target becomes a trailing stop instead of a sale
          const h = w
            ? await this.harvestCheck(pos, now)
            : { action: "HARVEST" as const, why: "no exit state" };
          if (h.action === "TRAIL" && w) {
            const extra = this.d.exits.harvest.max_extra_hours * 3_600_000;
            this.sql.exec(
              "UPDATE position_watch SET trailing = 1, extended_until = ? WHERE account = ? AND symbol = ?",
              pos.max_hold_until + extra,
              account,
              pos.symbol,
            );
            w.trailing = 1;
            w.extended_until = pos.max_hold_until + extra;
            this.journal.append(
              account,
              "HARVEST_TRAIL",
              pos.contract_id,
              { symbol: pos.symbol, bid: q.bid, target: pos.target_price, why: h.why },
              now,
            );
          } else reason = "TARGET";
        }
      }
      if (!reason && pos.state === "OPEN" && this.d.exits.earnings_derisk && pos.arena === "EQUITIES") {
        const horizon = utcDay(now + this.d.execution.earnings_blackout_hours * 3_600_000);
        const e = one<{ date: string }>(
          this.sql,
          "SELECT date FROM earnings WHERE symbol = ? AND date >= ? AND date <= ?",
          pos.symbol,
          utcDay(now),
          horizon,
        );
        if (e) reason = "EARNINGS_DERISK";
      }
      const holdUntil = w?.trailing === 1 && w.extended_until ? w.extended_until : pos.max_hold_until;
      if (!reason && now >= holdUntil) reason = "TIME_STOP";
      if (!reason && fresh && w && pos.state === "OPEN") {
        const st = this.exitState(pos, w);
        const move = ratchetStop(st, q.bid, this.d.exits, !this.regimeGate(pos.arena, null, now).open);
        if (move) await this.moveStop(account, broker, pos, move.stop, move.why, now);
        continue;
      }
      if (!reason) continue;
      if (await this.exitPosition(account, broker, pos, reason, q ?? null)) exits++;
    }
    return exits;
  }

  /** ADR-059 exit state for a position (initial stop from the watch row, ATR from its contract). */
  private exitState(pos: PositionRow, w: WatchRow): ExitState {
    const k = this.contract(pos.contract_id);
    const entry = Number(pos.avg_entry);
    return {
      entry,
      initialStop: w.initial_stop,
      stop: Number(pos.stop_price),
      target: Number(pos.target_price),
      atr: k?.atr ?? Math.max(entry - w.initial_stop, entry * 0.01),
      feeRt: pos.fee_rt,
      openedAt: pos.opened_at,
      maxHoldUntil: pos.max_hold_until,
      mfe: w.mfe,
      mae: w.mae,
      trailing: w.trailing === 1,
    };
  }

  /** The watch row for an open position, created on first sight (initial stop = the contract's stop). */
  private watchRow(account: AccountId, pos: PositionRow, now: number): WatchRow | null {
    if (!this.d.exits.enabled) return null;
    const w = one<WatchRow>(
      this.sql,
      "SELECT * FROM position_watch WHERE account = ? AND symbol = ?",
      account,
      pos.symbol,
    );
    if (w && w.contract_id === pos.contract_id) return w;
    const k = this.contract(pos.contract_id);
    const initial = Number(k?.invalidation_criteria.stop_price ?? pos.stop_price);
    const entry = Number(pos.avg_entry);
    const open =
      pos.arena === "CRYPTO" || pos.arena === "EQUITIES" ? this.regimeGate(pos.arena, null, now).open : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO position_watch (account, symbol, contract_id, initial_stop, mfe, mae, trailing,
         regime_open_at_entry, reviews) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`,
      account,
      pos.symbol,
      pos.contract_id,
      initial < entry ? initial : Number(pos.stop_price),
      entry,
      entry,
      open === null ? null : open ? 1 : 0,
    );
    return one<WatchRow>(
      this.sql,
      "SELECT * FROM position_watch WHERE account = ? AND symbol = ?",
      account,
      pos.symbol,
    );
  }

  /**
   * Move the stop up (never down): synthetic stop now, broker stop replaced on the next ensureProtectiveStops
   * (the old one is cancelled first; in between the synthetic stop protects every pulse, as before ADR-059).
   */
  private async moveStop(
    account: AccountId,
    broker: BrokerApi,
    pos: PositionRow,
    stop: number,
    why: string,
    now: number,
  ): Promise<void> {
    const old = Number(pos.stop_price);
    const tick = defaultTick(stop, pos.arena);
    const rounded = Number(roundPrice(stop, tick, "down"));
    if (!(rounded > old)) return;
    this.sql.exec(
      "UPDATE positions SET stop_price = ? WHERE account = ? AND symbol = ?",
      String(rounded),
      account,
      pos.symbol,
    );
    if (pos.broker_stop_coid) {
      const live = one<OrderRow>(
        this.sql,
        `SELECT * FROM orders WHERE client_order_id = ? AND state IN (${OPEN_SQL})`,
        pos.broker_stop_coid,
      );
      // Review finding: replacing the broker stop on every small trail step churns orders, and Alpaca refuses the new
      // sell while the old one is still cancelling. Small steps move only the synthetic stop (checked every pulse);
      // the broker stop follows in steps of ≥ 0.25 ATR, at breakeven, and when a review tightens.
      const atrNow = this.contract(pos.contract_id)?.atr ?? 0;
      const brokerStop = Number(live?.stop_price ?? 0);
      const bigStep = !live || rounded - brokerStop >= 0.25 * atrNow || why !== "TRAIL";
      if (!bigStep) {
        this.journal.append(
          account,
          "STOP_MOVE",
          pos.contract_id,
          { symbol: pos.symbol, from: old, to: rounded, why, broker: "kept" },
          now,
        );
        return;
      }
      if (live?.broker_order_id) {
        await broker.cancelOrder(live.broker_order_id).catch(() => undefined);
        this.sql.exec(
          "UPDATE orders SET state = 'pending_cancel', updated_at = ? WHERE client_order_id = ?",
          now,
          live.client_order_id,
        );
      }
      this.sql.exec(
        "UPDATE positions SET broker_stop_coid = NULL WHERE account = ? AND symbol = ?",
        account,
        pos.symbol,
      );
    }
    this.journal.append(
      account,
      "STOP_MOVE",
      pos.contract_id,
      { symbol: pos.symbol, from: old, to: rounded, why },
      now,
    );
  }

  /** Momentum checks for hold-or-harvest: regime, close vs EMA20 and RSI14 on daily bars, Kronos lean. */
  private async harvestCheck(
    pos: PositionRow,
    now: number,
  ): Promise<{ action: "HARVEST" | "TRAIL"; why: string }> {
    const cfg = this.d.exits;
    if (!cfg.enabled || !cfg.harvest.enabled) return { action: "HARVEST", why: "harvest mode off" };
    const m = this.deps.market;
    const bars = m
      ? await (pos.arena === "CRYPTO"
          ? m.cryptoDailyBars([pos.symbol], 40, now)
          : m.stockDailyBars([pos.symbol], 40, now)
        )
          .then((b) => b[pos.symbol])
          .catch(() => undefined)
      : undefined;
    const closes = bars?.map((b) => b.c) ?? [];
    const e20 = closes.length >= 20 ? ema(closes, 20) : null;
    const last = closes.at(-1);
    const k = this.kronosFor(pos.symbol, now);
    return holdOrHarvest(cfg, {
      regimeOpen: this.regimeGate(pos.arena, null, now).open,
      aboveEma20: e20 !== null && last !== undefined ? last > e20 : null,
      rsi14: closes.length >= 15 ? rsi(closes, 14) : null,
      kronosPUp: k ? k.p_up : null,
    });
  }

  /**
   * ADR-060 resting convictions: when the only things stopping a court contract are timing (price ran past the zone)
   * or a full book (max positions), it waits instead of being thrown away, up to `max_hours` and half its horizon.
   * Every gate runs again when it fires. With a full book, a stagnant position may be released for it (rotation).
   * Returns a short status, or null when the contract can't rest.
   */
  private async maybeRest(
    account: AccountId,
    contract: DecisionContract,
    reasons: string[],
    now: number,
  ): Promise<string | null> {
    const cfg = this.d.entry_timing.resting;
    if (!cfg.enabled || contract.origin !== "COURT") return null;
    const restable = (r: string) =>
      r === "price ran past the entry zone" || /^max positions \(\d+\) reached$/.test(r);
    if (!reasons.every(restable)) return null;
    const until = Math.min(
      now + cfg.max_hours * 3_600_000,
      now + (contract.invalidation_criteria.max_hold_hours * 3_600_000) / 2,
    );
    this.sql.exec(
      `INSERT OR REPLACE INTO resting (contract_id, account, symbol, until_at, created_at, checks, why)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      contract.contract_id,
      account,
      contract.symbol,
      until,
      now,
      reasons.join("; ").slice(0, 200),
    );
    let rotated: string | null = null;
    if (reasons.some((r) => r.startsWith("max positions")))
      rotated = await this.rotateFor(account, contract, now);
    this.journal.append(
      account,
      "RESTING",
      contract.contract_id,
      { symbol: contract.symbol, until, why: reasons, rotated },
      now,
    );
    return `${reasons[0]}; waits until ${new Date(until).toISOString().slice(5, 16)}Z${rotated ? `, releasing stagnant ${rotated}` : ""}`;
  }

  /** Rotation (MLP4-004): release the most stagnant position for a stronger waiting court contract. */
  private async rotateFor(
    account: AccountId,
    contract: DecisionContract,
    now: number,
  ): Promise<string | null> {
    const cfg = this.d.exits;
    const broker = this.deps.brokers[account];
    if (!cfg.enabled || !cfg.rotation.enabled || !broker) return null;
    if (contract.win_prob_used < cfg.rotation.min_candidate_win) return null;
    const positions = this.positions(account).filter((p) => p.state === "OPEN");
    const quotes = await this.quotesFor(positions.map((p) => p.symbol)).catch(
      () => ({}) as Record<string, Quote>,
    );
    let pick: { pos: PositionRow; r: number; q: Quote } | null = null;
    for (const pos of positions) {
      const q = quotes[pos.symbol];
      const w = this.watchRow(account, pos, now);
      if (!q || !w) continue;
      const s = this.exitState(pos, w);
      if (!stagnant(s, q.bid, now, cfg)) continue;
      const r = rMultiple(s, q.bid);
      if (!pick || r < pick.r) pick = { pos, r, q };
    }
    if (!pick) return null;
    const qty = Number(pick.pos.qty);
    const freed = {
      notionalUsd: qty * pick.q.bid,
      riskUsd: Math.max(0, qty * (Number(pick.pos.avg_entry) - Number(pick.pos.stop_price))),
    };
    if (!(await this.wouldEnterAfterFreeing(account, contract, freed, now))) return null;
    this.journal.append(
      account,
      "ROTATE",
      pick.pos.contract_id,
      {
        out: pick.pos.symbol,
        r: Math.round(pick.r * 100) / 100,
        in: contract.symbol,
        in_win: contract.win_prob_used,
      },
      now,
    );
    await this.exitPosition(account, broker, pick.pos, "ROTATE", pick.q);
    return pick.pos.symbol;
  }

  /** Each pulse: resting contracts whose zone came back (and a slot is free) go through every gate again. */
  private async runResting(): Promise<{ contracts: number; entries: number }> {
    const now = this.deps.now();
    if (!this.d.entry_timing.resting.enabled) return { contracts: 0, entries: 0 };
    this.sql.exec("DELETE FROM resting WHERE until_at < ?", now);
    const rows = this.sql.exec<{ contract_id: string; account: AccountId; symbol: string }>(
      "SELECT contract_id, account, symbol FROM resting ORDER BY created_at LIMIT 6",
    );
    let entries = 0;
    for (const row of rows) {
      const k = this.contract(row.contract_id);
      const view = this.accountView(row.account, now);
      if (!k || !view) {
        this.sql.exec(
          "DELETE FROM resting WHERE contract_id = ? AND account = ?",
          row.contract_id,
          row.account,
        );
        continue;
      }
      if (view.heldOrPendingSymbols.includes(row.symbol)) continue;
      const rung = this.d.rungs[view.rung];
      if (view.openSlots >= rung.max_positions) continue; // still full: keep waiting quietly
      const q = (await this.quotesFor([row.symbol]).catch(() => ({}) as Record<string, Quote>))[row.symbol];
      if (!q) continue;
      const low = Number(k.entry_plan.zone_low);
      const high = Number(k.entry_plan.zone_high);
      this.sql.exec(
        "UPDATE resting SET checks = checks + 1 WHERE contract_id = ? AND account = ?",
        row.contract_id,
        row.account,
      );
      if (q.bid > high || q.bid < low) continue; // not in the zone yet: no rejection spam
      this.lastRejections.delete(k.contract_id);
      const ok = await this.route(row.account, k, { [row.symbol]: q });
      const why = this.lastRejections.get(k.contract_id) ?? [];
      if (ok || !why.every((r) => r === "price ran past the entry zone" || r.startsWith("max positions"))) {
        this.sql.exec(
          "DELETE FROM resting WHERE contract_id = ? AND account = ?",
          row.contract_id,
          row.account,
        );
        this.journal.append(
          row.account,
          ok ? "RESTING_FILLED" : "RESTING_DROPPED",
          k.contract_id,
          { symbol: row.symbol, why: ok ? "zone came back" : why.slice(0, 3) },
          now,
        );
      }
      if (ok) entries++;
    }
    return { contracts: 0, entries };
  }

  /**
   * ADR-059 re-underwriting: positions with a new tripwire (regime flip, Kronos p10 breach, funding stress, a watch
   * dossier saying the thesis broke, or a material headline) get one Clef review: HOLD / TIGHTEN / EXIT. Models pick
   * the class only; code moves the stop or starts the exit. Never blocks trading; budgeted from the Tier 2 pool.
   */
  private async reviewPositions(now: number): Promise<number> {
    const cfg = this.d.exits;
    const clef = this.deps.clef;
    if (!cfg.enabled || !cfg.review.enabled || !clef) return 0;
    let done = 0;
    const seen = new Set<string>();
    for (const account of ACCOUNTS) {
      const broker = this.deps.brokers[account];
      if (!broker) continue;
      for (const pos of this.positions(account)) {
        if (pos.state !== "OPEN" || seen.has(pos.symbol)) continue;
        const w = this.watchRow(account, pos, now);
        if (!w) continue;
        const q = (await this.quotesFor([pos.symbol]).catch(() => ({}) as Record<string, Quote>))[pos.symbol];
        if (!q || now - q.at > this.d.staleness.quote_seconds * 1000) continue;
        const dz = this.dossierFor(pos.symbol, now);
        const k = this.kronosFor(pos.symbol, now);
        const wires = tripwires({
          arena: pos.arena,
          regimeOpenNow: pos.arena === "OPTIONS" ? null : this.regimeGate(pos.arena, null, now).open,
          regimeOpenAtEntry: w.regime_open_at_entry === null ? null : w.regime_open_at_entry === 1,
          kronos: k?.fan
            ? { p10: k.fan.p10, produced_at: k.produced_at, candle_hours: k.candle_hours ?? 4 }
            : null,
          fundingMultiplier: this.fundingMultiplier(pos.symbol, now),
          thesis: dz?.stage === "watch" && dz.as_of > pos.opened_at ? (dz.thesis?.status ?? null) : null,
          materialHeadline: w.pending_headline,
          bid: q.bid,
          now,
        });
        const key = JSON.stringify(wires);
        const cooled = !w.last_review_at || now - w.last_review_at >= cfg.review.cooldown_minutes * 60_000;
        const urgent = wires.some((x) => x.startsWith("headline:") || x.endsWith("thesis BROKEN"));
        // a review needs something new; within the cooldown only a headline or a broken thesis counts
        if (wires.length === 0 || key === w.last_tripwires || (!cooled && !urgent)) continue;
        if (this.daily("reviews", now) >= cfg.review.max_per_day) return done;
        // a review that failed (Clef down) is retried after 15 min with the same tripwires, not forgotten
        if (now - Number(getKV(this.sql, `review_failed:${pos.symbol}`) ?? 0) < 15 * 60_000) continue;
        const contract = this.contract(pos.contract_id);
        const st = this.exitState(pos, w);
        const req = buildReview({
          symbol: pos.symbol,
          arena: pos.arena,
          thesis: contract?.thesis_summary ?? "(rule strategy)",
          killCriteria: contract?.kill_criteria ?? [],
          entry: st.entry,
          stop: st.stop,
          target: st.target,
          bid: q.bid,
          r: rMultiple(st, q.bid),
          heldHours: (now - pos.opened_at) / 3_600_000,
          horizonHours: Math.round((pos.max_hold_until - pos.opened_at) / 3_600_000),
          tripwires: wires,
          regime: this.regimeContext(now),
          research: dz ? { summary: dz.summary, thesis: dz.thesis ?? null } : null,
          kronos: k
            ? { p_up: k.p_up, exp_ret: k.exp_ret, age_minutes: Math.round((now - k.produced_at) / 60_000) }
            : null,
        });
        const est = estimateTokens(req.state, req.questions);
        if (!this.budget.canSpendNeurons("neurons_tier2", neuronsFor("clef", est, this.d), now)) return done;
        this.bumpDaily("reviews", now);
        seen.add(pos.symbol);
        let res: ClefResult;
        try {
          res = await clef.run("clef", req.state, req.questions);
        } catch (e) {
          setKV(this.sql, `review_failed:${pos.symbol}`, String(now), now);
          this.journal.append(
            "SYSTEM",
            "REVIEW_FAILED",
            pos.contract_id,
            { symbol: pos.symbol, error: errText(e).slice(0, 160) },
            now,
          );
          continue;
        }
        this.sql.exec(
          `UPDATE position_watch SET last_review_at = ?, reviews = reviews + 1, last_tripwires = ?,
             pending_headline = NULL WHERE symbol = ?`,
          now,
          key,
          pos.symbol,
        );
        this.budget.add("neurons_tier2", neuronsFor("clef", res.usage.input_tokens ?? est, this.d), now);
        const dec = interpretReview(res, cfg);
        done++;
        this.journal.append(
          "SYSTEM",
          "REVIEW",
          pos.contract_id,
          { symbol: pos.symbol, prompt: REVIEW_PROMPT_VERSION, tripwires: wires, ...dec },
          now,
        );
        for (const a of ACCOUNTS) {
          const b = this.deps.brokers[a];
          const p = this.positions(a).find((x) => x.symbol === pos.symbol && x.state === "OPEN");
          if (!b || !p) continue;
          if (dec.action === "EXIT") await this.exitPosition(a, b, p, "REVIEW_EXIT", q);
          if (dec.action === "TIGHTEN") {
            const wa = this.watchRow(a, p, now);
            const ns = wa ? tightenedStop(this.exitState(p, wa), q.bid) : null;
            if (ns !== null) await this.moveStop(a, b, p, ns, "REVIEW_TIGHTEN", now);
          }
        }
        await this.deps.notifier.post("court", reviewCard(pos.symbol, wires, dec, rMultiple(st, q.bid)));
      }
    }
    return done;
  }

  /**
   * ADR-059 / MLP3-003: a daily surveillance dossier per held position. The research desk checks the bear's kill
   * criteria against fresh news; a WEAKENED/BROKEN thesis becomes a review tripwire.
   */
  private async dispatchWatches(now: number): Promise<void> {
    const cfg = this.d.exits;
    const dispatcher = this.deps.dispatcher;
    if (!cfg.enabled || !cfg.watch_research.enabled || !dispatcher || !this.d.funnel.research.enabled) return;
    const seen = new Set<string>();
    for (const account of ACCOUNTS) {
      for (const pos of this.positions(account)) {
        if (pos.state !== "OPEN" || seen.has(pos.symbol) || pos.arena === "OPTIONS") continue;
        seen.add(pos.symbol);
        if (now - pos.opened_at < 2 * 3_600_000) continue; // the case dossier is still fresh
        const key = `watch_dispatched:${pos.symbol}`;
        if (now - Number(getKV(this.sql, key) ?? 0) < cfg.watch_research.every_hours * 3_600_000) continue;
        if (this.daily("research", now) >= this.d.funnel.research.max_per_day) return;
        const k = this.contract(pos.contract_id);
        try {
          await dispatcher.dispatch("research.yml", {
            job: "dossier",
            symbol: pos.symbol,
            context:
              `Held since ${new Date(pos.opened_at).toISOString().slice(0, 16)}Z. Thesis: ${k?.thesis_summary ?? "rule strategy entry"}`
                .replace(/\s+/g, " ")
                .slice(0, 280),
            arena: pos.arena,
            mode: "watch",
            depth: "quick",
            catalyst: "",
            kill: (k?.kill_criteria ?? []).join(" | ").slice(0, 280),
          });
        } catch (e) {
          await this.alertOnce(
            "watch-dispatch",
            `⚠️ watch research dispatch failed: ${errText(e).slice(0, 160)}`,
          );
          return;
        }
        this.bumpDaily("research", now);
        setKV(this.sql, key, String(now), now);
        this.journal.append("SYSTEM", "WATCH_REQUEST", pos.contract_id, { symbol: pos.symbol }, now);
      }
    }
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
      // a replaced stop is still cancelling: a second full-size sell would be refused (qty held for orders)
      if (
        this.openOrders(account).some(
          (o) => o.symbol === pos.symbol && o.role === "STOP" && o.state === "pending_cancel",
        )
      )
        continue;
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
    const raw = evaluateBreaker(
      {
        equityCents: eq,
        hwmCents: row.hwm_cents,
        dayStartEquityCents: row.day_start_equity_cents ?? eq,
        stopouts24h: stopouts,
        locked: row.locked === 1,
      },
      this.d,
    );
    const streakKey = `breaker_recover:${account}`;
    const h = withHysteresis(row.breaker, raw, Number(getKV(this.sql, streakKey) ?? 0), this.d);
    if (String(h.streak) !== (getKV(this.sql, streakKey) ?? "0"))
      setKV(this.sql, streakKey, String(h.streak), now);
    const state = h.state;
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
  /** Backtest lab report (ADR-046): stored for the panel and posted as a report card to #governor. */
  private async ingestDossier(b: Batch, now: number): Promise<{ ok: boolean; message: string }> {
    const r = DossierPayloadSchema.safeParse(b.items.find((x) => x.skill_id === "deep-research")?.payload);
    if (!r.success) return { ok: false, message: "dossier payload failed the schema" };
    const dz = r.data;
    const target = this.universe.resolve([dz.symbol], now);
    if (!target || target.symbol !== dz.symbol)
      return { ok: false, message: `${dz.symbol} is not tradeable` };
    // ADR-058: symbols the research named as related are watched (their news always reaches Tier 1)
    const watched = this.universe.watch(
      dz.related.map((x) => x.symbol),
      `related:${dz.symbol}`,
      now,
    );
    // a late partial (fast ring) never replaces a complete dossier of the same run or newer
    const have = one<{ json: string; as_of: number }>(
      this.sql,
      "SELECT json, as_of FROM dossiers WHERE symbol = ?",
      dz.symbol,
    );
    const haveComplete = have ? (JSON.parse(have.json) as { complete?: boolean }).complete !== false : false;
    if (!(dz.complete === false && have && haveComplete && have.as_of >= dz.as_of - 30 * 60_000))
      this.sql.exec(
        "INSERT OR REPLACE INTO dossiers (symbol, as_of, json, received_at) VALUES (?, ?, ?, ?)",
        dz.symbol,
        Math.min(dz.as_of, now),
        JSON.stringify(dz),
        now,
      );
    const cfg = this.d.funnel.research;
    if (dz.complete) {
      // release the cases waiting for it: the next pulse's court hears them with the full dossier attached
      this.sql.exec("DELETE FROM court_waits WHERE symbol = ?", dz.symbol);
      this.sql.exec("DELETE FROM settings WHERE key = ?", `research_pending:${dz.symbol}`);
    } else {
      // operator 2026-10-26: keep waiting for the deep dossier, but no longer than deep_wait_minutes after dispatch;
      // then the court convenes on this fast one
      this.sql.exec(
        "UPDATE court_waits SET until_at = MIN(until_at, until_at - ?) WHERE symbol = ?",
        Math.max(0, cfg.wait_minutes - cfg.deep_wait_minutes) * 60_000,
        dz.symbol,
      );
    }
    this.journal.append(
      "SYSTEM",
      "DOSSIER",
      null,
      {
        symbol: dz.symbol,
        findings: dz.findings.length,
        read: dz.findings.filter((f) => f.verified).length,
        sources: dz.sources.length,
        stage: dz.stage,
        complete: dz.complete,
        watched,
        ...dz.agent,
      },
      now,
    );
    await this.deps.notifier.post("court", dossierCard(dz));
    return { ok: true, message: `stored dossier for ${dz.symbol} (${dz.findings.length} findings)` };
  }

  private async ingestBacktest(b: Batch, now: number): Promise<{ ok: boolean; message: string }> {
    const r = BacktestPayloadSchema.safeParse(b.items.find((x) => x.skill_id === "backtest-lab")?.payload);
    if (!r.success) return { ok: false, message: "backtest payload failed the schema" };
    setKV(this.sql, "backtest:latest", JSON.stringify({ produced_at: b.produced_at, ...r.data }), now);
    type Res = (typeof r.data.results)[string];
    const rows = Object.entries(r.data.results).sort(
      (x, y) => (y[1].expectancy_r ?? -9) - (x[1].expectancy_r ?? -9),
    );
    const mark: Record<string, string> = { PASS: "🟢", UNPROVEN: "🟡", LOSES: "🔴", "TOO FEW TRADES": "⚪" };
    const num = (x: number | null | undefined, f: (v: number) => string) =>
      x === null || x === undefined ? "—" : f(x);
    const line = ([id, s]: [string, Res]) =>
      `${mark[s.verdict] ?? "•"} \`${id}\` **${s.verdict}** · ${s.n} trades · win ${num(s.win_rate, (v) => `${Math.round(v * 100)}%`)} · ${num(s.expectancy_r, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`)}/trade · PF ${num(s.profit_factor, (v) => v.toFixed(2))} · q ${num(s.q_value, (v) => v.toFixed(3))} · latest third ${num(s.last_third_r, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`)} · DSR ${num(s.dsr, (v) => v.toFixed(2))}${s.lab ? " · 🧪 LAB" : ""}`;
    await this.deps.notifier.post("governor", {
      embeds: [
        {
          title: `🧪 Backtest lab — ${r.data.years} years, fees and slippage included`,
          description: rows.map(line).join("\n").slice(0, 3900),
          color: COLORS.cyan,
          fields: [
            ...(r.data.pbo === null || r.data.pbo === undefined
              ? []
              : [
                  {
                    name: "Overfitting check (PBO)",
                    value: `${Math.round(r.data.pbo * 100)}% chance the in-sample winner is below median out of sample${r.data.pbo >= 0.5 ? " — treat every PASS with suspicion" : ""}`,
                  },
                ]),
            { name: "Limits", value: r.data.limits.slice(0, 1000) },
          ],
          footer: {
            text: "PASS = positive edge that survives BH-FDR, holds in the latest third, and has a deflated Sharpe ≥ 0.95",
          },
        },
      ],
    });
    this.journal.append(
      "SYSTEM",
      "BACKTEST",
      null,
      Object.fromEntries(rows.map(([id, s]) => [id, s.verdict])),
      now,
    );
    return { ok: true, message: `stored ${rows.length} backtest results` };
  }

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
        candle_hours: r.data.candle_hours ?? 4,
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

  /**
   * ADR-047 panel: what Kronos thinks the market might do next, beside what the robot itself thinks — its open
   * position or latest plan for the symbol, the probability behind it, and the regime. Read-only.
   */
  forecastView(symbol: string, now = this.deps.now()) {
    let stored: {
      produced_at: number;
      model: string;
      horizon_hours: number;
      candle_hours?: number;
      forecasts: KronosForecast[];
    } | null = null;
    try {
      stored = JSON.parse(getKV(this.sql, "kronos:forecasts") ?? "null");
    } catch {
      stored = null;
    }
    const symbols = stored?.forecasts.map((f) => f.symbol) ?? [];
    const f = stored?.forecasts.find((x) => x.symbol === symbol) ?? null;
    const pos = ACCOUNTS.flatMap((a) => this.positions(a).map((p) => ({ ...p, account: a }))).find(
      (p) => p.symbol === symbol,
    );
    const row = one<{ json: string; created_at: number }>(
      this.sql,
      "SELECT json, created_at FROM contracts WHERE symbol = ? ORDER BY created_at DESC LIMIT 1",
      symbol,
    );
    const k = row ? (JSON.parse(row.json) as DecisionContract) : null;
    const arena = isCryptoSymbol(symbol) ? "CRYPTO" : "EQUITIES";
    const reg = this.freshRegime(arena, now);
    return {
      symbol,
      symbols,
      now,
      kronos:
        f && stored
          ? {
              model: stored.model,
              produced_at: stored.produced_at,
              stale:
                now - stored.produced_at > (kronosParams(this.d)?.max_forecast_age_hours ?? 5) * 3_600_000,
              horizon_hours: stored.horizon_hours,
              horizon_label: f.horizon_label ?? `${stored.horizon_hours} h`,
              candle_hours: f.candle_hours ?? stored.candle_hours ?? 4,
              confidence: "LOW" as const,
              about: KRONOS_ABOUT,
              last: f.last,
              hist: f.hist ?? [],
              fan: f.fan ?? null,
              p_up: f.p_up,
              p_win: f.p_win,
              exp_ret: f.exp_ret,
            }
          : null,
      robot: {
        position: pos
          ? {
              account: pos.account,
              entry: Number(pos.avg_entry),
              stop: Number(pos.stop_price),
              target: Number(pos.target_price),
              opened_at: pos.opened_at,
              max_hold_until: pos.max_hold_until,
            }
          : null,
        plan:
          k && row
            ? {
                strategy: k.strategy_id,
                origin: k.origin,
                created_at: row.created_at,
                entry_low: Number(k.entry_plan.zone_low),
                entry_high: Number(k.entry_plan.zone_high),
                stop: Number(k.invalidation_criteria.stop_price),
                target: Number(k.entry_plan.targets[0]),
                win_prob: k.win_prob_used,
                bear_lethality: k.bear_lethality,
                thesis: k.thesis_summary,
              }
            : null,
        regime: reg ? { posture: reg.posture, score: reg.score } : null,
      },
    };
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

  /**
   * Pull new headlines into triage_queue (deduped, capped at TRIAGE_QUEUE_MAX). Returns how many were queued.
   * ADR-058: with `universe.news_scope: all` the whole Alpaca news stream comes in, and the zero-neuron prefilter
   * keeps Tier 1 spend flat: core/held/watched symbols always pass, other headlines need catalyst words and a daily
   * slot, and near-duplicates of the last 4 h are dropped.
   */
  private async intakeNews(): Promise<number> {
    const m = this.deps.market;
    if (!m) return 0;
    const now = this.deps.now();
    const u = this.d.universe;
    const open = u.enabled && u.news_scope === "all";
    const cursor = one<{ value: string }>(this.sql, "SELECT value FROM cursors WHERE name = 'news'")?.value;
    const since = cursor ?? new Date(now - 3_600_000).toISOString();
    let items = await m.news(open ? ["*"] : this.newsSymbols(), since);
    if (open && items.length >= 50) {
      // a busy hour: one more page so the cursor keeps up with the wire
      const next = new Date((items.at(-1)?.createdAt ?? now) + 1000).toISOString();
      items = [...items, ...(await m.news(["*"], next))];
    }
    const priority = new Set<string>([
      ...this.newsSymbols(),
      ...this.universe.watched(now),
      ...this.symbolsInPlay(),
    ]);
    for (const s of [...priority]) priority.add(s.replace("/", ""));
    const recent = open ? this.universe.recentTokens(now) : [];
    let queued = 0;
    let dropped = 0;
    let last = since;
    for (const n of items) {
      // Alpaca's `start` is inclusive: step 1 s past the newest item, and remember ids so a dropped item
      // never comes back (it used to be re-triaged every pulse).
      last = new Date(Math.max(Date.parse(last), n.createdAt + 1000)).toISOString();
      const id = `news:${n.id}`;
      if (!this.markSeen(id, now)) continue;
      if (open) {
        const v = prefilter(
          { headline: n.headline, summary: n.summary, symbols: n.symbols, source: n.source },
          { priority, recent, minScore: u.prefilter_min_score },
        );
        const isPriority = v.why === "core/held/watched symbol";
        const slot = isPriority || this.daily("open_intake", now) < u.max_open_intake_per_day;
        if (!v.pass || !slot) {
          dropped++;
          continue;
        }
        if (!isPriority) this.bumpDaily("open_intake", now);
        recent.push(v.tokens);
        this.universe.rememberHeadline(id, v.tokens, now);
      }
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
    if (queued > 0 || dropped > 0)
      this.journal.append("SYSTEM", "NEWS_INTAKE", null, { queued, prefiltered: dropped, since }, now);
    return queued;
  }

  /**
   * ADR-058 scout: a symbol outside the universe got a promoted catalyst. Screen it in code (asset record, 30+ daily
   * bars, dollar volume, spread, no leveraged/inverse product, no stablecoin) and, if it passes, hot-port it as a
   * TRADE symbol for `ttl_days`. Cached rejections stop re-screening for a day. Never trades by itself.
   */
  private async scoutPort(
    symbols: string[],
    why: string,
    now: number,
    source = "scout",
  ): Promise<{ symbol: string; arena: "CRYPTO" | "EQUITIES" } | { reason: string }> {
    const u = this.d.universe;
    if (!u.enabled) return { reason: "no tradeable symbol" };
    const m = this.deps.market;
    const via = (["PAPER", "LIVE"] as AccountId[]).find((a) => this.deps.brokers[a]);
    if (!m || !via) return { reason: "no tradeable symbol (no market data to screen it)" };
    const cands = [
      ...new Map(
        symbols
          .map(normalizeSymbol)
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .map((x) => [x.symbol, x]),
      ).values(),
    ].slice(0, 3);
    if (cands.length === 0) return { reason: "no tradeable symbol" };
    let reason = "no tradeable symbol";
    for (const c of cands) {
      const prev = this.universe.row(c.symbol);
      if (prev?.status === "REJECTED" && prev.expires_at > now) {
        reason = `${c.symbol} failed the universe screen: ${prev.reason}`;
        continue;
      }
      if (this.daily("ports", now) >= u.max_ports_per_day)
        return { reason: "scout port cap reached for today" };
      this.bumpDaily("ports", now);
      const [asset, bars, quotes] = await Promise.all([
        this.assetMeta(c.symbol, via).catch(() => null),
        (c.arena === "CRYPTO"
          ? m.cryptoDailyBars([c.symbol], 45, now)
          : m.stockDailyBars([c.symbol], 45, now)
        )
          .then((b) => b[c.symbol])
          .catch(() => undefined),
        this.quotesFor([c.symbol]).catch(() => ({}) as Record<string, Quote>),
      ]);
      const res = screenAsset(
        { symbol: c.symbol, arena: c.arena, asset, bars, quote: quotes[c.symbol] },
        this.d,
        this.c,
      );
      this.universe.record(c.symbol, c.arena, res, source, why, now);
      this.journal.append(
        "SYSTEM",
        res.ok ? "UNIVERSE_PORT" : "UNIVERSE_REJECT",
        null,
        {
          symbol: c.symbol,
          arena: c.arena,
          source,
          why: why.slice(0, 160),
          reasons: res.reasons,
          ...res.metrics,
        },
        now,
      );
      if (res.ok) return { symbol: c.symbol, arena: c.arena };
      reason = `${c.symbol} failed the universe screen: ${res.reasons.slice(0, 2).join("; ")}`;
    }
    return { reason };
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
      // ADR-058: a hot-ported stock needs a calendar that covers the whole market, not just the watchlists
      if (this.universe.isDynamic(contract.symbol, now) && getKV(this.sql, "earnings_coverage") !== "all")
        return "earnings calendar doesn't cover hot-ported stocks (fail closed)";
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
    const insane = await this.sanityVeto(contract, now);
    if (insane) return insane;
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
    // Audit W3-02: no bars used to pass the guard silently (fail-open). Now it refuses; unknowns are counted.
    if (!cand) {
      this.vacuum("correlation_no_bars", now);
      return "correlation check impossible (no daily bars for the candidate)";
    }
    const since = now - g.lookback_days * 86_400_000;
    for (const h of held)
      if (!bars[h] || correlation(cand, bars[h] as Bar[], since) === null)
        this.vacuum("correlation_unknown", now);
    const heldBars = Object.fromEntries(held.filter((h) => bars[h]).map((h) => [h, bars[h] as Bar[]]));
    const hit = correlationVeto(cand, heldBars, g.max_corr, since);
    return hit ? `correlated with ${hit.symbol} (ρ=${hit.corr} > ${g.max_corr})` : null;
  }

  /**
   * ADR-067 sanity vetoes: a depegged stablecoin or a cross-venue price gap blocks crypto entries; a Nasdaq halt blocks
   * a stock entry. Sources are cached (venue 60 s, halts 5 min). An unreachable source is counted as a policy vacuum
   * and doesn't block: the validator's own quote, spread and staleness gates still fail closed.
   */
  private async sanityVeto(contract: DecisionContract, now: number): Promise<string | null> {
    const cfg = this.d.execution.sanity;
    if (!cfg.enabled) return null;
    const http = this.deps.http;
    const cached = async (key: string, ttl: number, load: () => Promise<string>): Promise<string | null> => {
      const hit = getKV(this.sql, key);
      const at = Number(getKV(this.sql, `${key}:at`) ?? 0);
      if (hit !== null && now - at < ttl) return hit;
      try {
        const v = await load();
        setKV(this.sql, key, v, now);
        setKV(this.sql, `${key}:at`, String(now), now);
        return v;
      } catch {
        this.vacuum(`sanity:${key.split(":")[0]}`, now);
        return null;
      }
    };
    if (contract.arena === "CRYPTO") {
      const q = await this.quotesFor(["USDT/USD", "USDC/USD", contract.symbol]).catch(
        () => ({}) as Record<string, Quote>,
      );
      for (const st of ["USDT/USD", "USDC/USD"]) {
        const x = q[st];
        const bps = x ? depegBps((x.bid + x.ask) / 2) : null;
        if (bps !== null && bps > cfg.max_depeg_bps)
          return `${st.slice(0, 4)} is ${bps} bps off its $1 peg (sanity veto)`;
      }
      const own = q[contract.symbol];
      if (http && own) {
        const raw = await cached(`venue:${contract.symbol}`, 60_000, async () => {
          const r = await http(
            `https://api.exchange.coinbase.com/products/${coinbaseProduct(contract.symbol)}/ticker`,
            {
              headers: { "user-agent": "cortex-54" },
              signal: AbortSignal.timeout(4_000),
            },
          );
          if (!r.ok) throw new Error(String(r.status));
          const t = (await r.json()) as { bid?: string; ask?: string };
          return String((Number(t.bid) + Number(t.ask)) / 2);
        });
        const gap = venueGapPct((own.bid + own.ask) / 2, raw === null ? null : Number(raw));
        if (gap !== null && gap > cfg.max_venue_gap_pct)
          return `Alpaca and Coinbase disagree by ${gap}% on ${contract.symbol} (sanity veto)`;
      }
    }
    if (contract.arena === "EQUITIES" && http) {
      const raw = await cached("halts:nasdaq", 5 * 60_000, async () => {
        const r = await http("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts", {
          headers: { "user-agent": "Mozilla/5.0 (cortex-54)" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!r.ok) throw new Error(String(r.status));
        return [...haltedSymbols(await r.text())].join(",");
      });
      if (raw?.split(",").includes(contract.symbol)) return `${contract.symbol} is halted (Nasdaq halt feed)`;
    }
    return null;
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
    const kv = (k: string) => {
      try {
        const v = JSON.parse(getKV(this.sql, k) ?? "null") as { at: number } & Record<string, unknown>;
        return v && now - v.at <= 12 * 3_600_000 ? v : null;
      } catch {
        return null;
      }
    };
    const funding = kv("funding");
    const hmm = kv("hmm:BTC/USD");
    return {
      crypto: c ? { posture: c.posture, score: c.score } : "stale/unknown",
      equities: e ? { posture: e.posture, score: e.score, ceiling: e.ceiling } : "stale/unknown",
      // audit W2-30: perp funding, annualized (crowding when beyond ±35%; code halves crypto size there)
      perp_funding_annualized: funding?.annualized ?? null,
      // audit W2-29: LOW-confidence 2-state volatility model on BTC daily returns
      btc_volatility_regime: hmm
        ? {
            confidence: "LOW",
            p_high_volatility_state: hmm.p_high_vol_now,
            persistence_high: hmm.persist_high,
            daily_vol_low_vs_high: [hmm.vol_low_daily, hmm.vol_high_daily],
          }
        : null,
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
      const facts = interpretFacts(r, cfg.min_confidence, text);
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
    let target: { symbol: string; arena: "CRYPTO" | "EQUITIES" } | null = this.universe.resolve(symbols, now);
    if (target && this.universe.isDynamic(target.symbol, now)) this.universe.touch(target.symbol, now);
    if (!target && t1?.direction !== "down") {
      const ported = await this.scoutPort(symbols, String(p.headline ?? "").slice(0, 200), now);
      if ("reason" in ported)
        return { ok: false, reason: ported.reason, symbol: symbols[0] ?? "", arena: "?" };
      target = ported;
    }
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
    // Audit W2-40: never convene a court on an old quote (the validator would refuse the order anyway).
    if (q.at && now - q.at > this.d.staleness.quote_seconds * 1000)
      return { ok: false, reason: "quote is stale", symbol, arena };
    const created = typeof p.createdAt === "number" ? p.createdAt : row.enqueued_at;
    // ADR-060 lateness meter: how much of the move is already done since the headline (hourly bars, code math)
    const lt = this.d.entry_timing.lateness;
    const a14d = atr(b, 14);
    const timing =
      lt.enabled && p.kind !== "operator" && p.kind !== "roast" && m.hourlyBars && a14d
        ? lateness(
            await m.hourlyBars(symbol, created - 26 * 3_600_000).catch(() => []),
            created,
            q.bid,
            a14d,
            now,
            lt,
          )
        : null;
    if (timing?.verdict === "LATE")
      return {
        ok: false,
        reason: `late: price already moved ${timing.move_since_atr} ATR since the headline (lateness meter)`,
        symbol,
        arena,
        hypothetical: { bid: q.bid, atr: a14d, gate: true, timing },
      };
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
      quoteAt: q.at,
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
              horizon_label: f.horizon_label ?? `${f.horizon_hours} h`,
              age_minutes: Math.round((now - f.produced_at) / 60_000),
              p_up: f.p_up,
              p_win: f.p_win,
              p_target_first: f.p_target_first,
              p_stop_first: f.p_stop_first,
              exp_ret: f.exp_ret,
            }
          : null)(this.kronosFor(symbol, now)),
      research: ((dz) => (dz ? researchView(dz, now) : null))(this.dossierFor(symbol, now)),
      timing,
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
    let result: ClefResult;
    try {
      result = await clef.run("clef", req.state, req.questions);
    } catch (e) {
      // Audit W2-10: the candidate was already dequeued; record the loss instead of dropping it silently.
      this.rejectCandidate(
        {
          candidateId: row.candidate_id,
          symbol: ev.evidence.symbol,
          arena: ev.evidence.arena,
          source: "tier2",
        },
        "TIER2",
        [`Clef error: ${errText(e).slice(0, 120)}`],
        { bid: ev.evidence.quote.bid, atr: ev.evidence.technicals.atr14 },
        now,
      );
      throw e;
    }
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
    await this.requestResearch(
      row.candidate_id,
      ev.evidence.symbol,
      ev.evidence.arena,
      `Tier 2 passed it (quality ${dcs.quality100}/100). Catalyst: ${ev.evidence.catalyst.headline}`,
      now,
      {
        // MLP4-013: the strongest cases (and exception-lane ones) get the long research budget
        depth: dcs.quality100 >= 90 || ev.evidence.regimeException ? "deep" : "standard",
        catalyst: ev.evidence.catalyst.headline,
      },
    );
    return 1;
  }

  /** Fresh dossier for a symbol (ADR-051), or null. */
  dossierFor(symbol: string, now = this.deps.now()): Dossier | null {
    const row = one<{ as_of: number; json: string }>(
      this.sql,
      "SELECT as_of, json FROM dossiers WHERE symbol = ?",
      symbol,
    );
    if (!row || now - row.as_of > this.d.funnel.research.fresh_hours * 3_600_000) return null;
    const r = DossierPayloadSchema.safeParse(JSON.parse(row.json));
    return r.success ? r.data : null;
  }

  /**
   * ADR-051: ask the web research desk (GitHub Actions) for a dossier and hold the court case until it lands or
   * `wait_minutes` pass. Returns true when the case is now waiting. Never blocks the court on failure.
   */
  private async requestResearch(
    candidateId: string,
    symbol: string,
    arena: "CRYPTO" | "EQUITIES",
    context: string,
    now: number,
    opts: { depth?: "quick" | "standard" | "deep"; catalyst?: string } = {},
  ): Promise<boolean> {
    const cfg = this.d.funnel.research;
    const dispatcher = this.deps.dispatcher;
    if (!cfg.enabled || !dispatcher || this.dossierFor(symbol, now)) return false;
    const waitMs = cfg.wait_minutes * 60_000;
    const pendingKey = `research_pending:${symbol}`;
    const pending = Number(getKV(this.sql, pendingKey) ?? 0);
    const hold = (from: number) => {
      this.sql.exec(
        "INSERT OR REPLACE INTO court_waits (candidate_id, symbol, until_at) VALUES (?, ?, ?)",
        candidateId,
        symbol,
        from + waitMs,
      );
      return true;
    };
    if (now - pending < waitMs) return hold(pending); // already being researched
    if (this.daily("research", now) >= cfg.max_per_day) return false;
    try {
      await dispatcher.dispatch("research.yml", {
        job: "dossier",
        symbol,
        context: context.replace(/\s+/g, " ").slice(0, 280),
        // ADR-057: arena (scout-ported symbols aren't in the watchlists), stake-weighted depth, the catalyst itself
        arena,
        mode: "case",
        depth: opts.depth ?? "standard",
        catalyst: (opts.catalyst ?? "").replace(/\s+/g, " ").slice(0, 280),
      });
    } catch (e) {
      await this.alertOnce("research", `⚠️ research dispatch failed (${symbol}): ${errText(e).slice(0, 200)}`);
      return false;
    }
    this.bumpDaily("research", now);
    setKV(this.sql, pendingKey, String(now), now);
    this.journal.append(
      "SYSTEM",
      "RESEARCH_REQUEST",
      candidateId,
      { symbol, arena, context, depth: opts.depth ?? "standard" },
      now,
    );
    return hold(now);
  }

  /**
   * Operator-requested court session (`/court SYMBOL`): skips Tiers 1–2 but not Tier 0 gates, the daily cap, the
   * kill flag, the budget mode, or the validator/sizer. Runs immediately.
   */
  async requestCourt(symbolInput: string, by: string): Promise<string> {
    const now = this.deps.now();
    let target: { symbol: string; arena: "CRYPTO" | "EQUITIES" } | null = this.universe.resolve(
      [symbolInput.trim()],
      now,
    );
    if (!target && !this.universe.enabled)
      return `${symbolInput} isn't in the tradeable universe (doctrine watchlists).`;
    if (!target) {
      // ADR-058: the operator may name any symbol; the scout screens it like a catalyst would
      const ported = await this.scoutPort([symbolInput.trim()], `operator /court by ${by}`, now, "operator");
      if ("reason" in ported) return `${symbolInput} can't be traded: ${ported.reason}.`;
      target = ported;
    }
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
    if (
      await this.requestResearch(
        id,
        target.symbol,
        target.arena,
        `Operator asked the court to review ${target.symbol} (no specific catalyst).`,
        now,
      )
    ) {
      await this.flushJournal();
      return `📚 Research desk dispatched for ${target.symbol}. The court convenes when the deep research lands (fast research after ${this.d.funnel.research.deep_wait_minutes} min if the deep run is slow; ≤ ${this.d.funnel.research.wait_minutes} min) — its card appears in the feed (COURT).`;
    }
    const n = await this.runCourt();
    await this.flushJournal();
    return n > 0
      ? `Court session for ${target.symbol} finished — see the feed (COURT).`
      : `Court session for ${target.symbol} ended without a contract — the reasons are in the feed (COURT).`;
  }

  /**
   * PSS-013 co-pilot (`/roast SYMBOL thesis`): the operator's own trade idea goes through Tier 0 and the full court
   * (bull, cross-family bear, rebuttal, panel, judge) right now. It never trades: no contract, no order, ever.
   */
  async requestRoast(symbolInput: string, thesis: string, by: string): Promise<string> {
    const now = this.deps.now();
    const idea = thesis.replace(/\s+/g, " ").trim().slice(0, 280);
    if (idea.length < 10)
      return "Give the idea in a sentence, e.g. `/roast NVDA thesis: datacenter capex beats, buying the dip`.";
    let target: { symbol: string; arena: "CRYPTO" | "EQUITIES" } | null = this.universe.resolve(
      [symbolInput],
      now,
    );
    if (!target && this.universe.enabled) {
      const ported = await this.scoutPort([symbolInput], `operator /roast by ${by}`, now, "operator");
      if ("reason" in ported) return `${symbolInput} can't be judged: ${ported.reason}.`;
      target = ported;
    }
    if (!target) return `${symbolInput} isn't in the tradeable universe.`;
    if ((await this.readKill()) !== "CLEAR") return "Kill flag is set; no court sessions.";
    if (this.daily("court", now) >= this.d.funnel.tier3.max_sprints_per_day)
      return "Daily court cap reached.";
    const id = `roast:${target.symbol}:${now}`;
    this.sql.exec(
      "INSERT INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 3, ?, ?, ?)",
      id,
      target.symbol,
      JSON.stringify({
        kind: "roast",
        headline: `Operator's own trade idea (co-pilot roast, no order will be placed): ${idea}`,
        symbols: [target.symbol],
        source: by,
        createdAt: now,
      }),
      now - 366 * 86_400_000,
    );
    const n = await this.runCourt();
    await this.flushJournal();
    return n > 0
      ? `🔥 Roast of ${target.symbol} is in the feed (COURT). No order placed.`
      : `The idea on ${target.symbol} didn't survive — the reasons are in the feed (COURT), or ask WHY ${target.symbol}.`;
  }

  /**
   * ADR-061 weekly book review (Sundays from 18:00 UTC, or on demand with `/book`): R, age and stagnation per position,
   * the strongest pairwise correlation, net beta to BTC and SPY in dollars, and a crash replay (each holding's worst
   * 5-day drop in the past year, applied to today's notional). Measurement only.
   */
  async bookReview(force = false): Promise<BookSummary | null> {
    const now = this.deps.now();
    const d = new Date(now);
    const week = `${d.getUTCFullYear()}-${Math.floor((now - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
    if (
      !force &&
      (d.getUTCDay() !== 0 || d.getUTCHours() < 18 || getKV(this.sql, "book_review_week") === week)
    )
      return null;
    if (!force) setKV(this.sql, "book_review_week", week, now);
    const m = this.deps.market;
    const account: AccountId = this.deps.brokers.PAPER ? "PAPER" : "LIVE";
    const view = this.accountView(account, now);
    const positions = this.positions(account);
    if (!m || !view) return null;
    const syms = positions.map((p) => p.symbol);
    const crypto = [...new Set([...syms.filter(isCryptoSymbol), "BTC/USD"])];
    const stocks = [...new Set([...syms.filter((x) => !isCryptoSymbol(x)), "SPY"])];
    const [cb, sb, quotes] = await Promise.all([
      m.cryptoDailyBars(crypto, 370, now).catch(() => ({}) as Record<string, Bar[]>),
      m.stockDailyBars(stocks, 260, now).catch(() => ({}) as Record<string, Bar[]>),
      this.quotesFor(syms).catch(() => ({}) as Record<string, Quote>),
    ]);
    const bars: Record<string, Bar[]> = { ...cb, ...sb };
    const lines: BookLine[] = positions.map((p) => {
      const q = quotes[p.symbol];
      const w = this.watchRow(account, p, now);
      const st = w ? this.exitState(p, w) : null;
      const px = q?.bid ?? Number(p.avg_entry);
      const b = bars[p.symbol] ?? [];
      return {
        symbol: p.symbol,
        arena: p.arena,
        notionalUsd: Math.round(Number(p.qty) * px * 100) / 100,
        r: st ? Math.round(rMultiple(st, px) * 100) / 100 : 0,
        horizonFraction:
          Math.round(((now - p.opened_at) / Math.max(1, p.max_hold_until - p.opened_at)) * 100) / 100,
        stagnant: st && q ? stagnant(st, q.bid, now, this.d.exits) : false,
        betaBtc: bars["BTC/USD"] ? beta(b, bars["BTC/USD"]) : null,
        betaSpy: bars.SPY ? beta(b, bars.SPY) : null,
        worst5d: worstWindow(b, 5),
      };
    });
    const pairs: { a: string; b: string; corr: number }[] = [];
    for (let i = 0; i < syms.length; i++)
      for (let j = i + 1; j < syms.length; j++) {
        const x = bars[syms[i] as string];
        const y = bars[syms[j] as string];
        const c = x && y ? correlation(x, y, now - 60 * 86_400_000) : null;
        if (c !== null)
          pairs.push({ a: syms[i] as string, b: syms[j] as string, corr: Math.round(c * 100) / 100 });
      }
    const sum = summarizeBook(lines, view.equityUsd, pairs);
    this.journal.append(
      account,
      "BOOK_REVIEW",
      null,
      { ...sum, lines: sum.lines.map((l) => ({ ...l })) },
      now,
    );
    await this.deps.notifier.post("governor", bookCard(account, sum));
    return sum;
  }

  /**
   * ADR-068 community hub: publish this agent's public journal rows (signed, hash-linked) and pull the court
   * approvals of followed agents in as candidates. A followed idea is only a lead: it goes through Tier 2, the court,
   * the risk engine and this account's own sizing like any headline. Every 30 min at most; failures retry later.
   */
  private async hubSync(now: number): Promise<void> {
    const hub = this.deps.hub;
    const http = this.deps.http;
    if (!hub || !http) return;
    if (now - Number(getKV(this.sql, "hub_sync_at") ?? 0) < 30 * 60_000) return;
    setKV(this.sql, "hub_sync_at", String(now), now);
    if (hub.publish) {
      const rows = this.sql.exec<{ seq: number; row_json: string }>(
        "SELECT seq, row_json FROM hub_outbox ORDER BY seq LIMIT 200",
      );
      const r = await publishBatch(
        http,
        hub,
        rows.map((x) => JSON.parse(x.row_json)),
        this.journal.head(),
        now,
      );
      if (r.ok && rows.length) this.sql.exec("DELETE FROM hub_outbox WHERE seq <= ?", rows.at(-1)?.seq ?? 0);
      if (!r.ok) await this.alertOnce("hub-publish", `⚠️ hub publish failed: HTTP ${r.status} ${r.body}`);
    }
    for (const agent of hub.follow.slice(0, 10)) {
      const key = `hub_follow:${agent}`;
      const rows = await fetchFeed(http, hub.url, agent, Number(getKV(this.sql, key) ?? 0));
      for (const row of rows) {
        setKV(this.sql, key, String(row.seq), now);
        const p = JSON.parse(row.payload_json) as {
          symbol?: string;
          origin?: string;
          thesis?: string;
          win?: number;
        };
        if (p.origin !== "COURT" || !p.symbol || now - row.ts > 6 * 3_600_000) continue;
        const id = `follow:${agent}:${row.seq}`;
        if (!this.markSeen(id, now)) continue;
        this.sql.exec(
          "INSERT INTO triage_queue (candidate_id, tier, symbol, payload_json, enqueued_at) VALUES (?, 2, ?, ?, ?)",
          id,
          p.symbol,
          JSON.stringify({
            kind: "follow",
            headline: `Followed agent ${agent}'s court approved a long in ${p.symbol}: ${String(p.thesis ?? "").slice(0, 200)}`,
            summary: "",
            symbols: [p.symbol],
            source: `hub:${agent}`,
            createdAt: row.ts,
            tier1: { material: 0.7, direction: "up", escalate: 1.5 },
          }),
          now,
        );
        this.journal.append("SYSTEM", "FOLLOW_LEAD", id, { symbol: p.symbol, agent, seq: row.seq }, now);
      }
    }
  }

  /** `/universe`: the dynamic universe right now. */
  universeView(): string {
    const now = this.deps.now();
    if (!this.universe.enabled) return "Dynamic universe is off (doctrine universe.enabled).";
    const c = this.universe.counts(now);
    const rows = this.universe.list(now);
    const fmt = (st: string) =>
      rows
        .filter((r) => r.status === st)
        .slice(0, 15)
        .map((r) => r.symbol)
        .join(", ") || "—";
    return [
      `🌐 Universe: ${c.trade} hot-ported · ${c.watch} watched · ${c.rejected} refused today (core watchlists always on)`,
      `**Trade:** ${fmt("TRADE")}`,
      `**Watch:** ${fmt("WATCH")}`,
      `**Refused:** ${
        rows
          .filter((r) => r.status === "REJECTED")
          .slice(0, 6)
          .map((r) => `${r.symbol} (${r.reason.slice(0, 50)})`)
          .join("; ") || "—"
      }`,
      `Today: ${this.daily("ports", now)}/${this.d.universe.max_ports_per_day} screens · ${this.daily("open_intake", now)}/${this.d.universe.max_open_intake_per_day} wire headlines into Tier 1`,
    ]
      .join("\n")
      .slice(0, 1900);
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
    // ADR-051: cases waiting for their research dossier are skipped until it lands or the wait expires.
    const row = one<{ candidate_id: string; payload_json: string; enqueued_at: number }>(
      this.sql,
      `SELECT candidate_id, payload_json, enqueued_at FROM triage_queue WHERE tier = 3
         AND candidate_id NOT IN (SELECT candidate_id FROM court_waits WHERE until_at > ?)
       ORDER BY enqueued_at LIMIT 1`,
      now,
    );
    if (!row) return 0;
    this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", row.candidate_id); // one shot per candidate
    this.sql.exec("DELETE FROM court_waits WHERE candidate_id = ?", row.candidate_id);
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
    const hearingStart = this.deps.now();
    const deadline = this.d.llm_routing.hearing_deadline_ms;
    const elapsed = () => this.deps.now() - hearingStart;
    const degraded: string[] = [];
    let llmCalls = 0;
    const seed = Number.parseInt(sprintId.replace(/-/g, "").slice(-8), 16) >>> 0;
    const persona = BEAR_PERSONAS[seed % BEAR_PERSONAS.length] ?? BEAR_PERSONAS[0];
    const evidenceJson = JSON.stringify(evidenceForModels(e));
    const session: CourtSession = {
      symbol: e.symbol,
      arena: e.arena,
      catalyst: e.catalyst,
      bid: e.quote.bid,
      atr: e.technicals.atr14,
      facts: e.facts?.values ?? null,
      kronos: e.forecast?.view ?? null,
      research: e.research ? this.dossierFor(e.symbol, now) : null,
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
      (a) => {
        llmCalls += a.outcome === "UNAVAILABLE" || a.outcome === "SKIPPED_FAMILY" ? 0 : 1;
        this.logLlm(sprintId, "BULL", BULL_PROMPT_VERSION, a, this.deps.now());
      },
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
        system: bearSystem(persona),
        user: `Evidence JSON:\n${evidenceJson}\n\nBull brief JSON:\n${JSON.stringify(checked.bull)}`,
        maxOutputTokens: 1500,
        schema: BEAR_SCHEMA as unknown as Record<string, unknown>,
      },
      (j) => BearSchema.parse(j),
      this.d.llm_routing.require_cross_family ? [bull.family] : [],
      (a) => {
        llmCalls += a.outcome === "UNAVAILABLE" || a.outcome === "SKIPPED_FAMILY" ? 0 : 1;
        this.logLlm(sprintId, "BEAR", BEAR_PROMPT_VERSION, a, this.deps.now());
      },
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
    if (panelCfg.rebuttal && elapsed() > deadline * 0.4) degraded.push("rebuttal");
    if (panelCfg.rebuttal && elapsed() <= deadline * 0.4) {
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
        (a) => {
          llmCalls += a.outcome === "UNAVAILABLE" || a.outcome === "SKIPPED_FAMILY" ? 0 : 1;
          this.logLlm(sprintId, "REBUTTAL", REBUTTAL_PROMPT_VERSION, a, this.deps.now());
        },
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
    // Audit W2-05: the advisory panel is the first thing dropped when the hearing runs long.
    const seats = elapsed() > deadline * 0.6 ? [] : panelCfg.seats;
    if (seats.length < panelCfg.seats.length) degraded.push("panel");
    if (degraded.length > 0)
      this.journal.append(
        "SYSTEM",
        "HEARING_DEGRADED",
        row.candidate_id,
        { sprint: sprintId, dropped: degraded, ms: elapsed() },
        now,
      );
    const panel = (
      await Promise.all(
        seats.map(async (id, i) => {
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
          const log = (a: HopAttempt) => {
            llmCalls += a.outcome === "UNAVAILABLE" || a.outcome === "SKIPPED_FAMILY" ? 0 : 1;
            this.logLlm(sprintId, `PANEL_${id.toUpperCase()}`, PANEL_PROMPT_VERSION, a, this.deps.now());
          };
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

    // Audit W2-02: the judge reads the seats in a per-hearing order so no seat always speaks first.
    const shuffled = [...panel].sort(
      (a, b) =>
        ((seed ^ (a.seat.charCodeAt(0) * 2654435761)) >>> 0) -
        ((seed ^ (b.seat.charCodeAt(0) * 2654435761)) >>> 0),
    );
    const synthReq = buildSynth(e, checked.bull, bear.value, { rebuttal, panel: shuffled });
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
    let synthRes: ClefResult;
    try {
      synthRes = await clef.run("clef", synthReq.state, synthReq.questions);
    } catch (e) {
      this.rejectCandidate(
        cand,
        "SYNTH",
        [`Clef error: ${errText(e).slice(0, 120)}`],
        { ...checked.bull },
        now,
      );
      await close(`❌ Clef judge unavailable: ${errText(e).slice(0, 120)}`, false);
      return 0;
    }
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
    // Audit W2-07: a contested ruling (lethal bear, or a bull who retreated ≥ 2 conviction points) may be taxed.
    const contested =
      synth.bearLethality >= 0.5 ||
      (rebuttal !== null && checked.bull.conviction - rebuttal.revised_conviction >= 2);
    const tax = contested ? this.d.funnel.tier3.disagreement_tax : 1;
    const winUsed = Math.min(calibrated, calibrated * tax);
    session.synth = { ...synth, calibrated: winUsed };
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
      calibratedWin: winUsed,
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
    if (row.candidate_id.startsWith("roast:")) {
      // PSS-013 co-pilot: the operator's own idea got the full hearing; it never becomes a contract or an order
      this.journal.append(
        "SYSTEM",
        "ROAST",
        row.candidate_id,
        {
          symbol: e.symbol,
          win_cal: winUsed,
          bear: bear.value.lethality,
          entry: [contract.entry_plan.zone_low, contract.entry_plan.zone_high],
          stop: contract.invalidation_criteria.stop_price,
          targets: contract.entry_plan.targets,
        },
        now,
      );
      await close(
        `🧪 Roast only — no order. The court would size this at a calibrated ${Math.round(winUsed * 100)}% win chance: buy ${contract.entry_plan.zone_low}–${contract.entry_plan.zone_high}, stop ${contract.invalidation_criteria.stop_price}, target ${contract.entry_plan.targets[0]}.`,
        false,
      );
      return 1;
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
        // audit W2-01: keep each seat's independent view so the Governor can grade panel vs plain votes vs judge
        panel: panel.map((p) => ({ seat: p.seat, stance: p.stance, confidence: p.confidence, by: p.by })),
        bear_persona: persona.id,
        // audit W2-33: features for a later meta-label (size) model, logged from day one
        features: {
          spread_bps: e.quote.spread_bps,
          atr_pct: e.technicals.atr_pct,
          dist_ema20_pct: e.technicals.dist_ema20_pct,
          rsi14: e.technicals.rsi14,
          change_5d_pct: e.technicals.change_5d_pct,
          catalyst_age_min: e.catalyst.ageMinutes,
          catalyst_kind: e.catalyst.kind,
          tier1_material: e.catalyst.tier1?.material ?? null,
          research_findings: e.research?.findings.length ?? 0,
          kronos_p_up: e.forecast?.p_up ?? null,
        },
        contested,
        win_used: winUsed,
        degraded,
        // audit W2-03: numbers each side stated that appear nowhere in the evidence (graded later, never blocking)
        // the proposed trade's own prices are code-checked, so they count as known
        uncited: ((known: string) => ({
          bull: uncitedNumbers([checked.bull.thesis], known).length,
          bear: uncitedNumbers([...bear.value.fatal_flaws, ...bear.value.kill_criteria], known).length,
          panel: uncitedNumbers(
            panel.flatMap((p) => [p.headline, ...p.points]),
            known,
          ).length,
        }))(`${evidenceJson}${JSON.stringify(checked.bull)}`),
        // audit W1-38/W2-39: what this decision cost; W1-28: which policy generation authorized it
        cost: { llm_calls: llmCalls, clef_tokens: synthRes.usage.input_tokens ?? est, ms: elapsed() },
        policy: {
          doctrine_sha256: getKV(this.sql, "running_doctrine"),
          constitution: getKV(this.sql, "running_constitution"),
        },
        rebuttal: rebuttal
          ? {
              held: rebuttal.still_long,
              conceded: rebuttal.concessions.length,
              conviction: rebuttal.revised_conviction,
            }
          : null,
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
      const rested = !ok && why ? await this.maybeRest(account, contract, why, now) : null;
      outcomes.push(
        ok
          ? `✅ ${account}: entry order placed`
          : rested
            ? `⏳ ${account}: resting — ${rested}`
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
      } else if (items.length === 1) {
        // Audit W1-20: an item Clef keeps failing on must not block the queue forever. Three tries, then a record.
        const it = items[0] as TriageItem;
        const key = `t1_fail:${it.candidateId}`;
        const n = Number(getKV(this.sql, key) ?? 0) + 1;
        setKV(this.sql, key, String(n), now);
        if (n >= 3) {
          this.sql.exec("DELETE FROM triage_queue WHERE candidate_id = ?", it.candidateId);
          this.sql.exec("DELETE FROM settings WHERE key = ?", key);
          this.rejectCandidate(
            {
              candidateId: it.candidateId,
              symbol: this.universe.resolve(it.symbols, now)?.symbol ?? it.symbols[0] ?? "?",
              arena: this.universe.resolve(it.symbols, now)?.arena ?? "CRYPTO",
              source: "tier1",
            },
            "TIER1",
            [`Clef failed 3 times: ${errText(e).slice(0, 120)}`],
            {},
            now,
          );
        }
      }
      throw e;
    }
    const latency = this.deps.now() - started;
    const neurons = neuronsFor("clef-flash", result.usage.input_tokens ?? est, this.d);
    this.budget.add("neurons_tier1", neurons, now);

    const decisions = interpretTier1(items, result, this.d);
    let promoted = 0;
    const held = new Set(this.symbolsInPlay());
    for (const [i, dcs] of decisions.entries()) {
      const it = items[i] as TriageItem;
      // ADR-059: a material headline about a held symbol (either direction) is a re-underwriting tripwire
      const heldSym = this.universe.resolve(it.symbols, now)?.symbol;
      if (heldSym && held.has(heldSym) && dcs.material >= this.d.exits.review.held_material_min)
        this.sql.exec(
          "UPDATE position_watch SET pending_headline = ? WHERE symbol = ?",
          `${dcs.direction === "down" ? "⬇ " : dcs.direction === "up" ? "⬆ " : ""}${it.headline}`.slice(
            0,
            300,
          ),
          heldSym,
        );
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
    setKV(this.sql, `batch_seen:${b.job}`, String(now), now); // audit W1-07: dispatch receipts
    if (b.doctrine_sha256) await this.checkDeployLag(b.doctrine_sha256, now);
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
    if (b.job === "backtest") return this.ingestBacktest(b, now);
    if (b.job === "dossier") return this.ingestDossier(b, now);
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
    // Audit W2-30 / W2-29: keep perp funding and the volatility-regime read for sizing and court context.
    const fund = b.items.find((x) => x.skill_id === "crypto-funding-liquidation-scanner")?.payload as
      | { annualized?: Record<string, number> }
      | undefined;
    if (fund?.annualized && Object.values(fund.annualized).every((v) => Number.isFinite(v)))
      setKV(this.sql, "funding", JSON.stringify({ at: b.produced_at, annualized: fund.annualized }), now);
    const hmm = b.items.find((x) => x.skill_id === "hmm-regime")?.payload as
      | Record<string, unknown>
      | undefined;
    if (hmm && typeof hmm.p_high_vol_now === "number")
      setKV(this.sql, "hmm:BTC/USD", JSON.stringify({ at: b.produced_at, ...hmm }), now);
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
      | { events?: { symbol?: unknown; date?: unknown }[]; coverage?: unknown }
      | undefined;
    if (cal && Array.isArray(cal.events)) {
      this.sql.exec("DELETE FROM earnings");
      // ADR-058: a truncated full-market calendar would pass dynamic stocks unchecked, so it doesn't count as "all"
      const complete = cal.events.length <= EARNINGS_MAX_ROWS;
      setKV(this.sql, "earnings_coverage", cal.coverage === "all" && complete ? "all" : "watchlist", now);
      for (const ev of cal.events.slice(0, EARNINGS_MAX_ROWS)) {
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

  /**
   * ADR-056: COURT stock entries are sized by the equity posture (REDUCE_ONLY → half) and all stock exposure on the
   * account stays under the exposure coach's ceiling. Rule strategies and crypto are untouched. Shrink only.
   */
  equityPostureLimits(
    account: string,
    contract: DecisionContract,
    equityUsd: number,
    now: number,
  ): { multiplier: number; roomUsd: number; reason?: string } {
    if (contract.arena !== "EQUITIES" || contract.origin !== "COURT")
      return { multiplier: 1, roomUsd: Infinity };
    const eq = this.freshRegime("EQUITIES", now);
    if (!eq) return { multiplier: 1, roomUsd: Infinity }; // the regime gate already failed closed on stale data
    const multiplier = Math.min(1, this.d.regime_gates.equity_posture_size[eq.posture] ?? 1);
    if (eq.ceiling === null) return { multiplier, roomUsd: Infinity };
    const held =
      (one<{ n: number }>(
        this.sql,
        "SELECT COALESCE(SUM(CAST(qty AS REAL) * CAST(avg_entry AS REAL)), 0) AS n FROM positions WHERE account = ? AND arena = 'EQUITIES' AND state = 'OPEN'",
        account,
      )?.n ?? 0) +
      (one<{ n: number }>(
        this.sql,
        `SELECT COALESCE(SUM(notional_cents), 0) / 100.0 AS n FROM orders WHERE account = ? AND arena = 'EQUITIES' AND role = 'ENTRY' AND state IN (${OPEN_SQL})`,
        account,
      )?.n ?? 0);
    const roomUsd = eq.ceiling * equityUsd - held;
    if (roomUsd < (this.d.execution.min_order_notional_usd.EQUITIES ?? 1))
      return {
        multiplier,
        roomUsd: 0,
        reason: `stock exposure at the ${(eq.ceiling * 100).toFixed(0)}% ceiling (${eq.posture})`,
      };
    return { multiplier, roomUsd };
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
      // Equity batches only run Mon–Fri, so weekend hours don't count toward the alarm (the trading gate above
      // still uses wall-clock age and fails closed).
      const ageMs = arena === "EQUITIES" ? weekdayMsBetween(row.as_of, now) : now - row.as_of;
      const limit = this.d.staleness.regime_batch_hours[arena] ?? 24;
      if (ageMs <= limit * 3_600_000) continue;
      const hours = (ageMs / 3_600_000).toFixed(1);
      await this.alertOnce(
        `stale-batch:${arena}`,
        `⏳ ${arena} regime batch is ${hours}h old${arena === "EQUITIES" ? " (weekday hours)" : ""} (limit ${limit}h). Check the research workflow in GitHub Actions.`,
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
      // thesis + plan are what followers read on the hub (ADR-068); prices are public, nothing here is secret
      {
        symbol: k.symbol,
        strategy: k.strategy_id,
        origin: k.origin,
        thesis: k.thesis_summary,
        arena: k.arena,
        win: Math.round(k.win_prob_used * 100) / 100,
      },
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
    const baseView = this.accountView(account, now);
    if (!baseView) return false;
    const posture = this.equityPostureLimits(account, contract, baseView.equityUsd, now);
    if (posture.reason) {
      this.reject(account, contract, "VALIDATOR", [posture.reason], now);
      return false;
    }
    const view = { ...baseView, availableCashUsd: Math.min(baseView.availableCashUsd, posture.roomUsd) };
    const asset = this.assetView(meta, contract.arena);
    const v = validateEntry(
      {
        contract,
        account: view,
        market: {
          bid: q.bid,
          ask: q.ask,
          quoteAt: q.at,
          typicalSpreadFrac: this.typicalSpread(contract.symbol),
        },
        asset,
        reputationWeight: repWeight,
        regimeMultiplier: Math.min(
          exception ? lane.size_multiplier : 1,
          this.fundingMultiplier(contract.symbol, now),
          posture.multiplier,
        ),
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

  private assetView(meta: AlpacaAsset, arena: Arena): AssetView {
    return {
      tradable: meta.tradable && meta.status === "active",
      fractionable: meta.fractionable,
      minQty: meta.min_order_size ? Number(meta.min_order_size) : 0,
      qtyIncrement: meta.min_trade_increment ? Number(meta.min_trade_increment) : 1e-9,
      minNotionalUsd: Math.max(1, this.d.execution.min_order_notional_usd[arena] ?? 1),
    };
  }

  /**
   * Would this contract pass the whole validator (fee hurdle and sizing included) if `freed` were sold first? Used
   * before a rotation, so a stagnant position is only released for a newcomer that can actually enter (review finding).
   */
  private async wouldEnterAfterFreeing(
    account: AccountId,
    contract: DecisionContract,
    freed: { notionalUsd: number; riskUsd: number },
    now: number,
  ): Promise<boolean> {
    const q = (await this.quotesFor([contract.symbol]).catch(() => ({}) as Record<string, Quote>))[
      contract.symbol
    ];
    const meta = await this.assetMeta(contract.symbol, account).catch(() => null);
    const view = this.accountView(account, now);
    if (!q || !meta || !view) return false;
    const v = validateEntry(
      {
        contract,
        account: {
          ...view,
          openSlots: Math.max(0, view.openSlots - 1),
          availableCashUsd: view.availableCashUsd + freed.notionalUsd,
          heatUsedUsd: Math.max(0, view.heatUsedUsd - freed.riskUsd),
        },
        market: {
          bid: q.bid,
          ask: q.ask,
          quoteAt: q.at,
          typicalSpreadFrac: this.typicalSpread(contract.symbol),
        },
        asset: this.assetView(meta, contract.arena),
        reputationWeight: this.reputationWeight(this.catalystKey(contract.bull_case_receipts)),
        regimeMultiplier: this.fundingMultiplier(contract.symbol, now),
        now,
      },
      this.d,
      this.c,
    );
    // the price may still be above the zone: that's what resting waits for
    return v.ok || v.reasons.every((r) => r === "price ran past the entry zone");
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
    this.journal.append(
      account,
      "REJECT",
      contract.contract_id,
      { symbol: contract.symbol, stage, reasons },
      now,
    );
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
      } else if (e instanceof BrokerError && (e.status === 408 || e.status >= 500)) {
        // Audit W3-11: the request may have landed even though the response didn't — ask before declaring failure.
        res = await broker.orderByClientId(coid).catch(() => null);
      }
      if (!res && e instanceof BrokerError && e.status === 429) {
        this.journal.append(account, "ORDER_THROTTLED", coid, { symbol: o.symbol, role: o.role }, now);
        return false; // Alpaca throttled us: try again next pulse, no alarm
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
      killed: getKV(this.sql, "kill_seen") === "1" && this.killedFor(account),
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
    const all = { ...a, ...b };
    this.sampleSpreads(all, this.deps.now());
    return all;
  }

  /** Audit W3-06: ≤ 1 spread sample per symbol per 5 min, last 40 kept (≈ the recent few hours of quotes). */
  private sampleSpreads(quotes: Record<string, Quote>, now: number): void {
    for (const [sym, q] of Object.entries(quotes)) {
      if (!(q.bid > 0 && q.ask >= q.bid)) continue;
      const key = `spreads:${sym}`;
      let v: { at: number; s: number[] } = { at: 0, s: [] };
      try {
        v = JSON.parse(getKV(this.sql, key) ?? '{"at":0,"s":[]}');
      } catch {
        /* reset */
      }
      if (now - v.at < 5 * 60_000) continue;
      const frac = (q.ask - q.bid) / ((q.ask + q.bid) / 2);
      setKV(
        this.sql,
        key,
        JSON.stringify({ at: now, s: [...v.s, Math.round(frac * 1e6) / 1e6].slice(-40) }),
        now,
      );
    }
  }

  /** p90 of the recent spread samples, or null with fewer than 10. */
  typicalSpread(symbol: string): number | null {
    try {
      const v = JSON.parse(getKV(this.sql, `spreads:${symbol}`) ?? "null") as { s: number[] } | null;
      if (!v || v.s.length < 10) return null;
      const sorted = [...v.s].sort((x, y) => x - y);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? null;
    } catch {
      return null;
    }
  }

  /** ADR-075: model calls today per provider (from the router gate's counters) against each daily cap. */
  modelUse(now: number): StatusView["modelUse"] {
    const day = utcDay(now);
    const caps = this.d.llm_routing.daily_call_caps;
    const providers = this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM settings WHERE key LIKE 'llm_calls:%' AND key LIKE ?",
        `%:${day}`,
      )
      .map((r) => {
        const provider = r.key.slice("llm_calls:".length, -(day.length + 1));
        return { provider, calls: Number(r.value) || 0, cap: caps[provider] ?? null };
      })
      .sort((a, b) => b.calls - a.calls);
    let worst = { provider: "none", fraction: 0 };
    for (const p of providers)
      if (p.cap && p.calls / p.cap > worst.fraction)
        worst = { provider: p.provider, fraction: p.calls / p.cap };
    return { worst, providers };
  }

  status(): StatusView {
    const now = this.deps.now();
    const last = getKV(this.sql, "last_pulse_at");
    return {
      now,
      lastPulseAt: last ? Number(last) : null,
      budget: this.budget.snapshot(now),
      modelUse: this.modelUse(now),
      journalHead: this.journal.head(),
      outboxPending: this.journal.pending(),
      equity: this.equityHistory(now - 7 * 86_400_000),
      benchmark: Object.fromEntries(
        ACCOUNTS.filter((a) => this.deps.brokers[a]).map((a) => [a, this.benchmark(a, now - 7 * 86_400_000)]),
      ),
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
            startUsd: this.startEquityUsd(account),
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
    if (account === "LIVE" && stop > max) {
      // Audit W3-24: real-money autonomy takes two RATIFYs, the second 10 min – 24 h after the first.
      const key = `ratify_request:LIVE:${stop}`;
      const first = Number(getKV(this.sql, key) ?? 0);
      const wait = 10 * 60_000;
      if (!first || now - first > 86_400_000) {
        setKV(this.sql, key, String(now), now);
        this.journal.append(account, "RATIFY_REQUEST", null, { stop, by }, now);
        return `RATIFY recorded for LIVE Stop ${stop}. Confirm again with RATIFY between 10 minutes and 24 hours from now to make it take effect.`;
      }
      if (now - first < wait)
        return `Cooling off: confirm LIVE Stop ${stop} again in ${Math.ceil((first + wait - now) / 60_000)} min.`;
      this.sql.exec("DELETE FROM settings WHERE key = ?", key);
      setKV(this.sql, "live_ratified", JSON.stringify({ stop, by, at: now }), now);
    }
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
    const equity = Number(acct.equity);
    await this.freshStart(account, equity, "fresh start on a new broker account", by);
    return { ok: true, message: `${account} reset: broker equity $${equity.toFixed(2)}` };
  }

  /** ADR-081: the broker's own configuration caps borrowing at 1x (re-read at most every 30 min). */
  private async cashOnlyConfig(account: AccountId, broker: BrokerApi, now: number): Promise<boolean> {
    if (!broker.configuration) return false;
    const key = `broker_cash_only:${account}`;
    const cached = getKV(this.sql, key);
    if (cached) {
      const [at, v] = cached.split(",");
      if (now - Number(at) < 30 * 60_000) return v === "1";
    }
    const cfg = await broker.configuration().catch(() => null);
    if (!cfg) return false; // unknown: fail closed, and ask again next pulse
    const ok = Number(cfg.max_margin_multiplier) === 1;
    setKV(this.sql, key, `${now},${ok ? 1 : 0}`, now);
    return ok;
  }

  /** ADR-081: this account's starting equity in USD (first sight / last fresh start; else the doctrine's). */
  startEquityUsd(account: AccountId): number {
    const v = Number(getKV(this.sql, `start_equity:${account}`));
    return Number.isFinite(v) && v > 0 ? v / 100 : (this.d.accounts[account]?.starting_equity_usd ?? 0);
  }

  /** True when the stored equity history can't be this account's: no open positions, first sample ≥ 2× off. */
  private staleHistory(account: AccountId, equityUsd: number): boolean {
    if (this.positions(account).length > 0) return false;
    const first = one<{ equity_cents: number }>(
      this.sql,
      "SELECT equity_cents FROM equity_history WHERE account = ? ORDER BY at LIMIT 1",
      account,
    );
    if (!first || !(equityUsd > 0)) return false;
    const r = first.equity_cents / 100 / equityUsd;
    return r > 2 || r < 0.5;
  }

  /**
   * Wipe one account's hot trading state and re-create its row (ADR-038, ADR-081). The journal is append-only, so
   * it records RESET and keeps its chain; the Governor counts RESET as the start of the autonomous clock.
   */
  private async freshStart(account: AccountId, equity: number, reason: string, by: string): Promise<void> {
    const now = this.deps.now();
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
    this.sql.exec("DELETE FROM settings WHERE key = ?", `start_equity:${account}`);
    this.journal.append(account, "RESET", null, { by, broker_equity: equity, reason }, now);
    await this.flushJournal();
    await this.deps.notifier.post("alarms", {
      content: `🔄 ${account} reset to a fresh start (${reason}; by ${by}): equity $${equity.toFixed(2)}, history cleared, 30-day clock restarted.`,
    });
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
    // Audit W1-22/W3-26: the record says which accounts, why, and the sentinel's kill id.
    let meta: Record<string, unknown> = {};
    try {
      meta = {
        scope: JSON.parse(getKV(this.sql, "kill_scope") ?? "[]"),
        ...JSON.parse(getKV(this.sql, "kill_meta") ?? "{}"),
      };
    } catch {
      /* keep the transition even without details */
    }
    if (killed || prev === "1")
      this.journal.append("SYSTEM", killed ? "KILL_SEEN" : "KILL_CLEARED", null, killed ? meta : {}, now);
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
    // Audit W1-13: count every failure per stage per day (the alert itself is deduped to one an hour).
    const fk = `fail:${key.split(":")[0]}:${utcDay(now)}`;
    setKV(this.sql, fk, String(Number(getKV(this.sql, fk) ?? 0) + 1), now);
    const last = Number(getKV(this.sql, `alert:${key}`) ?? 0);
    if (now - last < 3_600_000) return;
    setKV(this.sql, `alert:${key}`, String(now), now);
    this.journal.append("SYSTEM", "ALERT", key, { text }, now);
    await this.deps.notifier.post("alarms", { content: text.slice(0, 1900) });
  }

  /**
   * Audit W1-39: multi-row invariants of the constitution, checked over hot state with plain SQL (no LLM). Non-zero
   * counts show up in /health, where the sentinel alerts on them through its own path.
   */
  policyViolations(now = this.deps.now()): Record<string, number> {
    const n = (q: string, ...b: SqlValue[]) => one<{ n: number }>(this.sql, q, ...b)?.n ?? 0;
    const v: Record<string, number> = {
      // U1: every open order traces to a contract (adopted orphans are named ADOPTED-… and tracked separately)
      order_without_contract: n(
        `SELECT COUNT(*) AS n FROM orders o WHERE o.state IN (${OPEN_SQL}) AND o.contract_id NOT LIKE 'ADOPTED-%'
           AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.contract_id = o.contract_id)`,
      ),
      // U4: every position has a stop
      position_without_stop: n(
        "SELECT COUNT(*) AS n FROM positions WHERE state = 'OPEN' AND (stop_price IS NULL OR CAST(stop_price AS REAL) <= 0)",
      ),
      // ADR-004: reservations are short-lived
      stale_reservation: n(
        "SELECT COUNT(*) AS n FROM risk_reservations WHERE expires_at < ?",
        now - 15 * 60_000,
      ),
      // U5: a RED-locked account has no live entry orders
      red_locked_with_entries: n(
        `SELECT COUNT(*) AS n FROM orders o JOIN accounts a ON a.account = o.account
           WHERE a.locked = 1 AND o.role = 'ENTRY' AND o.state IN (${OPEN_SQL})`,
      ),
      // U8: LIVE autonomy above the unratified ceiling has a ratification on record
      live_dial_unratified:
        n(
          "SELECT COUNT(*) AS n FROM accounts WHERE account = 'LIVE' AND autonomy_stop > ?",
          this.c.hard_limits.max_live_autonomy_stop_without_ratification,
        ) > 0 && !getKV(this.sql, "live_ratified")
          ? 1
          : 0,
      // U7: the audit trail is flowing (a deep outbox means D1 writes are stuck)
      outbox_backlog: n("SELECT COUNT(*) AS n FROM d1_outbox") > 2_000 ? 1 : 0,
    };
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x > 0));
  }

  /** Audit W1-32/W1-13: one-glance health numbers for /health and the sentinel. */
  slo(now = this.deps.now()): SloView {
    const last = Number(getKV(this.sql, "last_pulse_at") ?? 0);
    const b = this.budget.snapshot(now);
    const day = utcDay(now);
    const failures = Object.fromEntries(
      this.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM settings WHERE key LIKE 'fail:%' AND key LIKE ?",
          `%:${day}`,
        )
        .map((r) => [r.key.split(":")[1], Number(r.value)]),
    );
    return {
      pulse_age_s: last ? Math.round((now - last) / 1000) : null,
      outbox_depth: one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM d1_outbox")?.n ?? 0,
      outbox_dead: one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM d1_outbox_dead")?.n ?? 0,
      budget_mode: b.mode,
      budget_worst: { resource: b.worst.resource, fraction: Math.round(b.worst.fraction * 1000) / 1000 },
      budget_projected: {
        resource: b.projected.resource,
        fraction: Math.round(b.projected.fraction * 1000) / 1000,
      },
      alarm_lost_total: Number(getKV(this.sql, "alarm_lost_total") ?? 0),
      stage_failures_today: failures,
      policy_vacuums_today: Object.fromEntries(
        this.sql
          .exec<{ key: string; value: string }>(
            "SELECT key, value FROM settings WHERE key LIKE 'vacuum:%' AND key LIKE ?",
            `%:${day}`,
          )
          .map((r) => [r.key.split(":")[1], Number(r.value)]),
      ),
      court_waiting:
        one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM court_waits WHERE until_at > ?", now)?.n ?? 0,
    };
  }

  /**
   * Audit W2-30: crowded perpetual funding (|annualized| beyond the doctrine threshold) halves crypto entry size.
   * Shrink-only and computed in code, so models still never size (U2). Unknown or stale funding = no change.
   */
  fundingMultiplier(symbol: string, now: number): number {
    const f = this.d.sizing.funding_shrink;
    if (!f || !symbol.includes("/")) return 1;
    try {
      const v = JSON.parse(getKV(this.sql, "funding") ?? "null") as {
        at: number;
        annualized: Record<string, number>;
      } | null;
      if (!v || now - v.at > 12 * 3_600_000) return 1;
      const base = symbol.split("/")[0] ?? "";
      const own = v.annualized[base];
      const rate = own ?? Math.max(...Object.values(v.annualized).map(Math.abs));
      return Number.isFinite(rate) && Math.abs(rate) >= f.above_annualized ? f.multiplier : 1;
    } catch {
      return 1;
    }
  }

  /** Audit W3-02: count a fail-open branch that fired (a guard that could not decide), per site per day. */
  private vacuum(site: string, now: number): void {
    const k = `vacuum:${site}:${utcDay(now)}`;
    setKV(this.sql, k, String(Number(getKV(this.sql, k) ?? 0) + 1), now);
  }

  /** Audit W1-15: the cron self-heal found no alarm armed and restored it. Journaled so drops are countable. */
  noteAlarmLost(gapSeconds: number | null): void {
    const now = this.deps.now();
    const n = Number(getKV(this.sql, "alarm_lost_total") ?? 0) + 1;
    setKV(this.sql, "alarm_lost_total", String(n), now);
    this.journal.append("SYSTEM", "ALARM_LOST", null, { gap_s: gapSeconds, total: n }, now);
  }

  /** One equity sample per account per UTC hour (HUD chart, web terminal). */
  private async sampleEquity(now: number): Promise<void> {
    const hour = Math.floor(now / 3_600_000);
    if (getKV(this.sql, "equity_hour") === String(hour)) return;
    // MLP0-024: what holding BTC or SPY would have done with the same money (one quotes call per hour)
    const q = await this.quotesFor(["BTC/USD", "SPY"]).catch(() => ({}) as Record<string, Quote>);
    const mid = (x: Quote | undefined) => (x && x.bid > 0 ? (x.bid + x.ask) / 2 : null);
    this.sql.exec(
      "INSERT OR REPLACE INTO bench_history (at, btc, spy) VALUES (?, ?, ?)",
      hour * 3_600_000,
      mid(q["BTC/USD"]),
      mid(q.SPY),
    );
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

  /** Buy-and-hold BTC and SPY with the account's own equity at the window's first sample (MLP0-024). */
  benchmark(account: AccountId, since: number): { btc: number[][]; spy: number[][] } {
    const eq = this.equityHistory(since)[account] ?? [];
    const rows = this.sql.exec<{ at: number; btc: number | null; spy: number | null }>(
      "SELECT at, btc, spy FROM bench_history WHERE at >= ? ORDER BY at",
      since,
    );
    return benchmarkLines(eq, rows);
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

  isRevoked(id: string): boolean {
    // `one` returns null when there's no row (it was compared to undefined, so every session looked revoked)
    return one(this.sql, "SELECT 1 AS x FROM seen_items WHERE id = ?", `web:${id}`) !== null;
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

/** Journal kinds that feed the `/why` trail (each must carry a symbol, facts.symbol or out). */
const WHY_KINDS = new Set([
  "CANDIDATE_REJECT",
  "REJECT",
  "CONTRACT",
  "COURT",
  "ENTRY_FACTS",
  "EXIT",
  "STOP_MOVE",
  "HARVEST_TRAIL",
  "REVIEW",
  "RESTING",
  "RESTING_FILLED",
  "RESTING_DROPPED",
  "ROTATE",
  "UNIVERSE_PORT",
  "UNIVERSE_REJECT",
  "DOSSIER",
  "TIER2_PASS",
  "ROAST",
]);

/** Earnings rows kept per calendar batch (ADR-058: the whole market for 4 days ≈ 1–3k rows in earnings season). */
const EARNINGS_MAX_ROWS = 5000;
/** An equity earnings calendar older than this blocks equity entries (fail closed, ADR-035). */
const EARNINGS_CALENDAR_MAX_AGE_MS = 4 * 86_400_000;
