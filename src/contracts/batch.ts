import { z } from "zod";

/**
 * Payload POSTed by the GitHub Actions research jobs to /ingest/batch (docs/ARCHITECTURE.md §9).
 * The worker checks the HMAC; the brain validates this schema. Anything else is rejected.
 */
export const PostureSchema = z.object({
  arena: z.enum(["CRYPTO", "EQUITIES"]),
  /** Entry posture after the job's own synthesis (exposure-coach for equities, composite zone for crypto). */
  posture: z.enum(["NEW_ENTRY_ALLOWED", "REDUCE_ONLY", "CASH_PRIORITY"]),
  score: z.number().min(0).max(100),
  /** Net exposure ceiling as a fraction (equities); null when the job doesn't produce one. */
  ceiling: z.number().min(0).max(1).nullable(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable(),
  summary: z.string().max(600),
});
export type Posture = z.infer<typeof PostureSchema>;

export const BatchItemSchema = z.object({
  skill_id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().max(80), // upstream commit sha or our module version
  as_of: z.number().int(),
  inputs_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.record(z.string(), z.unknown()),
});

/** A world-intel candidate (GDELT article or EDGAR filing) headed for Tier 1 triage. */
export const WorldCandidateSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["gdelt", "edgar"]),
  title: z.string().min(1).max(400),
  url: z.url().nullable(),
  symbols: z.array(z.string().max(16)).max(12),
  source: z.string().max(80),
  published_at: z.number().int(),
  topic: z.string().max(80).optional(),
});
export type WorldCandidate = z.infer<typeof WorldCandidateSchema>;

export const BatchSchema = z
  .object({
    schema_version: z.literal(1),
    job: z.enum([
      "crypto-regime",
      "equity-posture",
      "world-intel",
      "governor",
      "options-lab",
      "screeners",
      "kronos",
      "backtest",
      "dossier",
    ]),
    produced_at: z.number().int(),
    run_url: z.url().nullable(),
    items: z.array(BatchItemSchema).min(1).max(20),
    posture: PostureSchema.nullable(),
    /** Audit W1-08: sha256 of config/doctrine.yaml on the commit the job ran from (deploy-lag check). */
    doctrine_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine(
    (b) =>
      ["world-intel", "governor", "options-lab", "screeners", "kronos", "backtest", "dossier"].includes(
        b.job,
      ) ===
      (b.posture === null),
    {
      message:
        "posture is required for regime jobs and must be null for world-intel / governor / options-lab / screeners / kronos / backtest / dossier",
    },
  );
export type Batch = z.infer<typeof BatchSchema>;

/** Max raw body the worker accepts (keeps JSON parsing well inside the 10 ms CPU budget). */
export const MAX_BATCH_BYTES = 64 * 1024;

/** Governor payloads (Phase 4). Each item's payload carries one of these lists. */
export const GradeSchema = z.object({
  rejection_id: z.number().int().positive(),
  horizon: z.enum(["24h", "72h", "7d"]),
  graded_at: z.number().int(),
  outcome_r: z.number().min(-50).max(50).nullable(),
  hit: z.enum(["STOP", "TARGET", "NEITHER"]),
});
export const PostmortemSchema = z.object({
  contract_id: z.string().max(80),
  account: z.enum(["PAPER", "LIVE"]),
  classification: z.enum([
    "GOOD_PROCESS_GOOD_OUTCOME",
    "GOOD_PROCESS_BAD_LUCK",
    "BAD_PROCESS_BAILOUT_LUCK",
    "BAD_PROCESS_LOSS",
  ]),
  realized_r: z.number().min(-50).max(50),
  notes: z.string().max(600),
});
export const ReputationSchema = z.object({
  source: z.string().min(1).max(80),
  signals: z.number().int().nonnegative(),
  brier_30d: z.number().min(0).max(1).nullable(),
  expectancy_r_30d: z.number().min(-50).max(50).nullable(),
  weight: z.number().min(0.5).max(1.2),
});
export const FitnessSchema = z.object({
  skill_id: z.string().min(1).max(80),
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  signals: z.number().int().nonnegative(),
  expectancy_r: z.number().nullable(),
  brier: z.number().min(0).max(1).nullable(),
  p_value: z.number().min(0).max(1).nullable(),
  p_value_bh: z.number().min(0).max(1).nullable(),
  status: z.string().max(20),
});
export const ReportCardSchema = z.object({
  title: z.string().max(200),
  sections: z.array(z.object({ name: z.string().max(100), value: z.string().max(1000) })).max(20),
  post: z.boolean(),
});

/** Options shadow-lab ledger event (Phase 5, ADR-031). Virtual only: the brain stores it, never trades it. */
export const OptionsLegSchema = z.object({
  symbol: z.string().regex(/^[A-Z]{1,6}\d{6}[CP]\d{8}$/),
  side: z.enum(["long", "short"]),
  kind: z.enum(["call", "put"]),
  strike: z.number().positive(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const OptionsEventSchema = z.object({
  trade_id: z.string().min(1).max(200),
  kind: z.enum(["OPEN", "CLOSE"]),
  ts: z.number().int(),
  strategy: z.string().regex(/^OPTIONS_[A-Z0-9_]+_V\d+$/),
  structure: z.string().max(40),
  underlying: z.string().regex(/^[A-Z.]{1,8}$/),
  legs: z.array(OptionsLegSchema).min(1).max(4),
  cash: z.number().min(-100_000).max(100_000),
  max_loss_cents: z.number().int().positive(),
  max_profit_cents: z.number().int().nullable(),
  fees_cents: z.number().int().nonnegative(),
  pnl_cents: z.number().int().nullable(),
  r: z.number().min(-50).max(50).nullable(),
  reason: z.enum(["TARGET", "STOP", "TIME", "EXPIRY"]).nullable(),
  sizer_permits_live: z.boolean(),
  detail: z.record(z.string(), z.unknown()),
});
export type OptionsEvent = z.infer<typeof OptionsEventSchema>;

/** Governor belief (docs/ARCHITECTURE.md §8): confidence decays as c0·0.5^(Δdays / half_life). */
export const BeliefSchema = z.object({
  belief_id: z.string().min(1).max(120),
  subject: z.string().min(1).max(40),
  tags: z.array(z.string().max(40)).max(10),
  statement: z.string().min(10).max(300),
  c0: z.number().min(0).max(1),
  half_life_days: z.number().positive().max(720),
  validated_at: z.number().int(),
  validations: z.number().int().positive(),
  status: z.enum(["ACTIVE", "STRUCTURAL", "ARCHIVED"]),
  evidence: z.array(z.string().max(80)).max(50),
});
export type Belief = z.infer<typeof BeliefSchema>;

/** Setup-screener hit (ADR-035): a deterministic setup proposed straight to Tier 2. */
export const ScreenerCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  screener: z.string().regex(/^[a-z0-9-]{3,60}$/),
  symbol: z.string().min(1).max(16),
  bar_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  score: z.number().int().min(0).max(100),
  state: z.string().max(40),
  headline: z.string().min(1).max(400),
  entry_reference: z.number().positive().nullable(),
  stop_reference: z.number().positive().nullable(),
  as_of: z.number().int(),
});

/** ADR-046: backtest lab report (research job `backtest`). */
const BacktestResult = z
  .object({
    n: z.number().int().nonnegative(),
    win_rate: z.number().nullable().optional(),
    expectancy_r: z.number().nullable().optional(),
    profit_factor: z.number().nullable().optional(),
    p_value: z.number().nullable().optional(),
    q_value: z.number().nullable().optional(),
    max_dd_r: z.number().nullable().optional(),
    first_two_thirds_r: z.number().nullable().optional(),
    last_third_r: z.number().nullable().optional(),
    status: z.string().optional(),
    lab: z.boolean().optional(),
    dsr: z.number().min(0).max(1).nullable().optional(),
    verdict: z.enum(["PASS", "UNPROVEN", "LOSES", "TOO FEW TRADES"]),
  })
  .loose();
export const BacktestPayloadSchema = z.object({
  years: z.number().positive(),
  start: z.string().max(20),
  results: z.record(z.string().max(60), BacktestResult),
  /** Audit W2-27: probability of backtest overfitting across the lab (CSCV on monthly R). */
  pbo: z.number().min(0).max(1).nullable().optional(),
  limits: z.string().max(1000),
});

/** ADR-051: deep-research dossier on one symbol (research job `dossier`, skill_id `deep-research`). */
const Day = z
  .string()
  .regex(/^20\d\d-[01]\d-[0-3]\d$/)
  .nullable();
const Stance = z.enum(["BULL", "BEAR", "NEUTRAL"]);
const Scope = z.enum(["MARKET", "CATALYST", "ASSET", "CONTRA"]);
export const DossierPayloadSchema = z.object({
  symbol: z.string().min(1).max(16),
  arena: z.enum(["CRYPTO", "EQUITIES"]),
  question: z.string().max(300),
  as_of: z.number().int(),
  /** ADR-057: fast (the court's copy), deep (replaces it later), watch (an open position). Older runs: absent. */
  stage: z.enum(["fast", "deep", "watch"]).default("fast"),
  /** false only for the early fast ring of a run still going deep: the court keeps waiting (deep_wait_minutes) */
  complete: z.boolean().default(true),
  summary: z.string().max(1200),
  /** ADR-057: the general market picture today (the MARKET scope). */
  market_context: z.string().max(700).default(""),
  /** ADR-057: where the triggering story came from (only URLs a tool returned survive). */
  catalyst_trace: z
    .object({
      first_reported: Day,
      original_source_url: z.string().max(500).nullable(),
      story: z.string().max(500),
    })
    .nullable()
    .default(null),
  bull_case: z.string().max(700),
  bear_case: z.string().max(700),
  catalysts: z
    .array(
      z.object({ event: z.string().min(1).max(200), date: Day, source_url: z.string().max(500).nullable() }),
    )
    .max(8),
  risks: z.array(z.string().max(200)).max(6),
  open_questions: z.array(z.string().max(200)).max(4),
  /** ADR-057 (crux-first, MLP6-001): the questions the decision turns on and what the research found. */
  cruxes: z
    .array(z.object({ question: z.string().max(200), answer: z.string().max(300).nullable() }))
    .max(3)
    .default([]),
  /** ADR-057: related symbols the research named (the scout screens them before watching any). */
  related: z
    .array(z.object({ symbol: z.string().min(1).max(16), relation: z.string().max(20) }))
    .max(8)
    .default([]),
  /** ADR-057: code-computed red flags from the filings a tool returned (dilution_filing:FORM:DATE, recent_8k:DATE). */
  flags: z.array(z.string().max(60)).max(6).default([]),
  /** ADR-057 watch mode: is the reason the position was bought still alive? */
  thesis: z
    .object({ status: z.enum(["INTACT", "WEAKENED", "BROKEN"]), reason: z.string().max(300) })
    .optional(),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(300),
        source_url: z.string().max(500),
        source_title: z.string().max(160),
        published: Day,
        stance: Stance,
        scope: Scope.default("ASSET"),
        verified: z.boolean(),
      }),
    )
    .max(24),
  sources: z
    .array(
      z.object({
        url: z.string().max(500),
        title: z.string().max(160),
        published: z.string().max(20).nullable(),
        read: z.boolean(),
      }),
    )
    .max(32),
  agent: z.object({
    prompt_version: z.string().max(40),
    models: z.array(z.string().max(80)).max(5),
    steps: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    pages_read: z.number().int().nonnegative(),
    wall_s: z.number().nonnegative(),
    tokens: z.number().int().nonnegative(),
    stop_reason: z.string().max(60),
    compactions: z.number().int().nonnegative().default(0),
  }),
});
export type Dossier = z.infer<typeof DossierPayloadSchema>;
