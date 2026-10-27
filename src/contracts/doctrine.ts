import { z } from "zod";
import { STRATEGY_PARAMS } from "../strategy/params.ts";
import type { Constitution } from "./constitution.ts";

const Fraction = z.number().gte(0).lte(1);
const Account = z.enum(["PAPER", "LIVE"]);
const Arena = z.enum(["CRYPTO", "EQUITIES", "OPTIONS"]);

const Rung = z.object({
  equity_min: z.number().nonnegative(),
  equity_max: z.number().positive().nullable(),
  total_heat: Fraction,
  per_trade_risk: Fraction,
  max_position_notional: Fraction,
  max_positions: z.number().int().positive(),
});

const LlmHop = z.object({ provider: z.string(), model: z.string() });

export const DoctrineSchema = z.object({
  version: z.number().int().positive(),
  accounts: z.record(
    Account,
    z.object({
      alpaca_base_url: z.url(),
      starting_equity_usd: z.number().positive(),
      autonomy_stop: z.number().int().min(0).max(4),
      apply_fee_model: z.boolean(),
    }),
  ),
  rungs: z.object({ R1: Rung, R2: Rung, R3: Rung, R4: Rung, R5: Rung }),
  breakers: z.object({
    yellow_drawdown: Fraction,
    orange_drawdown: Fraction,
    red_drawdown: Fraction,
    red_daily_loss: Fraction,
    red_consecutive_stopouts_24h: z.number().int().positive(),
    paper_auto_unlock_hours: z.number().positive(),
    multipliers: z.object({ GREEN: Fraction, YELLOW: Fraction, ORANGE: Fraction, RED: z.literal(0) }),
    /** Audit W3-01: recovery to a better band needs the drawdown this far under its threshold … */
    recovery_margin: Fraction.default(0.005),
    /** … for this many evaluations (pulses) in a row. Only slows recovery; never delays a worse band. */
    recovery_pulses: z.number().int().min(1).max(60).default(3),
  }),
  sizing: z.object({
    /** Audit W2-30: crowded perp funding shrinks crypto entries (shrink-only; absent = off). */
    funding_shrink: z
      .object({ above_annualized: z.number().positive().max(10), multiplier: z.number().gt(0).max(1) })
      .optional(),
    min_stop_atr_multiple: z.number().positive(),
    bear_disagreement: z.object({ floor: Fraction, max_penalty: Fraction }),
    reputation_weight: z.object({
      min: z.number().positive(),
      max: z.number().positive(),
      min_signals_before_adjusting: z.number().int().nonnegative(),
    }),
    edge_gate: z.object({ p_zero: Fraction, p_full: Fraction }),
    correlation_guard: z.object({ lookback_days: z.number().int().positive(), max_corr: Fraction }),
    /** ADR-042: lift a risk-sized order to the venue minimum, never past the rung's per-trade risk cap. */
    min_ticket: z.object({ max_upscale: z.number().min(1).max(10) }).default({ max_upscale: 1 }),
  }),
  fees: z.object({
    crypto_maker: Fraction,
    crypto_taker: Fraction,
    equity_commission: Fraction,
    equity_sell_regulatory_min_usd: z.number().nonnegative(),
    paper_slippage_bps: z.record(Arena, z.number().nonnegative()),
    hurdle_multiple: z.number().gte(1),
  }),
  execution: z.object({
    order_style: z.literal("passive_limit"),
    max_unfilled_pulses: z.number().int().positive(),
    exit_collar_bps: z.number().positive(),
    no_entry_last_minutes_of_session: z.number().int().nonnegative(),
    earnings_blackout_hours: z.number().int().nonnegative(),
    max_spread_bps: z.record(Arena, z.number().positive()),
    reservation_ttl_seconds: z.number().int().positive(),
    /** Venue minimum order cost per arena (Alpaca crypto: $10, verified 2026-10-24 from a 403). */
    min_order_notional_usd: z.record(Arena, z.number().nonnegative()),
    /** ADR-067: stablecoin depeg, cross-venue price and exchange-halt vetoes on new entries. */
    sanity: z
      .object({
        enabled: z.boolean(),
        max_depeg_bps: z.number().positive(),
        max_venue_gap_pct: z.number().positive(),
      })
      .default({ enabled: false, max_depeg_bps: 50, max_venue_gap_pct: 1 }),
  }),
  cadence: z.object({
    pulse_seconds_exposed: z.number().int().min(30),
    pulse_seconds_flat: z.number().int().min(60),
    pulse_seconds_thrift: z.number().int().min(60),
    hud_min_edit_interval_seconds: z.number().int().min(5),
  }),
  staleness: z.object({
    quote_seconds: z.number().int().positive(),
    regime_batch_hours: z.record(z.enum(["CRYPTO", "EQUITIES"]), z.number().positive()),
    screener_batch_hours: z.number().positive(),
    news_cursor_minutes: z.number().positive(),
  }),
  funnel: z.object({
    tier1: z.object({
      model: z.string(),
      batch_max_items: z.number().int().min(1).max(21),
      escalate_threshold: Fraction,
      min_escalate_score: z.number().min(0).max(3),
      max_batches_per_pulse: z.number().int().min(0).max(16),
    }),
    tier2: z.object({
      model: z.string(),
      pass_threshold: Fraction,
      max_per_day: z.number().int().nonnegative(),
    }),
    /** ADR-043: Clairic catalyst fact extraction (once per promoted candidate, cached for Tier 2 and the court). */
    facts: z.object({
      enabled: z.boolean(),
      min_confidence: Fraction,
      max_per_day: z.number().int().nonnegative(),
      min_chars: z.number().int().nonnegative(),
    }),
    research: z.object({
      enabled: z.boolean(),
      fresh_hours: z.number().positive().max(72),
      wait_minutes: z.number().int().min(1).max(120),
      /** operator 2026-10-26: with a fast dossier in hand, wait this long (from dispatch) for the deep one */
      deep_wait_minutes: z.number().int().min(1).max(120).default(12),
      max_per_day: z.number().int().nonnegative().max(100),
    }),
    tier3: z.object({
      max_sprints_per_day: z.number().int().nonnegative(),
      min_structural_score: z.number().min(0).max(100),
      /** Audit W2-07: multiplier on win_prob for contested rulings; 1.0 = measured and journaled but not applied. */
      disagreement_tax: z.number().gt(0).max(1).default(1),
    }),
    calibration: z.object({
      min_outcomes_before_trusting: z.number().int().positive(),
      shrink_to: Fraction,
      warmup_min_weight: Fraction,
    }),
  }),
  budgets: z.object({
    thrift_fraction: Fraction,
    hard_stop_fraction: Fraction,
    workers_ai_neurons_per_day: z.object({
      total_free: z.number().positive(),
      tier1: z.number().nonnegative(),
      tier2: z.number().nonnegative(),
      tier3_fallback: z.number().nonnegative(),
      clairic: z.number().nonnegative().default(0),
      reserve: z.number().nonnegative(),
    }),
    neurons_per_mtok: z.record(z.string(), z.number().positive()),
    daily_limits: z.record(z.string(), z.number().positive()),
    per_invocation: z.object({
      subrequests: z.number().int().positive(),
      cf_service_subrequests: z.number().int().positive(),
    }),
  }),
  llm_routing: z.object({
    families: z.record(z.string(), z.string()),
    bull_chain: z.array(LlmHop).min(1),
    bear_chain: z.array(LlmHop).min(1),
    /** ADR-044: bull rebuttal + expert panel. Seats rotate through the chain so each starts on a different model. */
    panel: z
      .object({
        rebuttal: z.boolean(),
        seats: z.array(z.enum(["quant", "risk", "macro"])),
        timeout_ms: z.number().int().positive().default(25_000),
        chain: z.array(LlmHop),
      })
      .default({ rebuttal: false, seats: [], timeout_ms: 25_000, chain: [] }),
    require_cross_family: z.boolean(),
    max_retries_per_provider: z.number().int().min(0).max(3),
    timeout_ms: z.number().int().positive(),
    /** Audit W2-05: a whole hearing's wall-clock budget; the panel is dropped first, then the rebuttal. */
    hearing_deadline_ms: z.number().int().positive().default(150_000),
    /** Audit W2-06: calls per provider per UTC day (free-tier RPD with margin); an exhausted provider is skipped. */
    daily_call_caps: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }),
  regime_gates: z.object({
    crypto_composite_min_for_longs: z.number().min(0).max(100),
    equity_postures_allowing_entries: z.array(z.string()),
    // ADR-056: size multiplier per equity posture for COURT entries (shrink only). Postures not listed size at 1.
    equity_posture_size: z.record(z.string(), z.number().gt(0).max(1)).default({}),
    exception_lane: z.object({
      enabled: z.boolean(),
      equity_postures: z.array(z.enum(["REDUCE_ONLY"])), // ADR-056: empty while REDUCE_ONLY is a regular posture
      crypto_composite_floor: z.number().min(0).max(100),
      min_tier1_material: Fraction,
      min_tier1_escalate: z.number().min(0).max(3),
      min_tier2_long_favored: Fraction,
      size_multiplier: z.number().gt(0).max(1), // can only shrink a position
      max_concurrent: z.number().int().min(0).max(3),
    }),
  }),
  /**
   * ADR-045: the LAB brain — a second instance on its own paper account and journal that forward-tests strategies
   * before they may trade on PAPER. Only these strategies run there (as ACTIVE); nothing else does.
   */
  lab: z.object({ strategies: z.array(z.string()) }).default({ strategies: [] }),
  strategies: z.array(
    z.object({
      id: z.string().regex(/^[A-Z0-9_]+_V\d+$/),
      arena: Arena,
      status: z.enum(["PROPOSAL", "SHADOW", "ACTIVE", "DEMOTED"]),
      universe: z.array(z.string()).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      accounts: z.array(Account),
    }),
  ),
  watchlists: z.record(z.string(), z.array(z.string())),
  /** ADR-060: entry timing. Lateness meter (Tier 0 veto on chased moves) and resting convictions. */
  entry_timing: z
    .object({
      lateness: z.object({
        enabled: z.boolean(),
        late_atr: z.number().positive(),
        mid_atr: z.number().positive(),
      }),
      resting: z.object({
        enabled: z.boolean(),
        max_hours: z
          .number()
          .positive()
          .max(24 * 7),
      }),
    })
    .default({
      lateness: { enabled: false, late_atr: 0.8, mid_atr: 0.4 },
      resting: { enabled: false, max_hours: 48 },
    }),
  /**
   * ADR-059: exit intelligence. Stops only ever tighten; models choose HOLD/TIGHTEN/EXIT, code computes prices.
   */
  exits: z
    .object({
      enabled: z.boolean(),
      breakeven_at_r: z.number().positive(),
      trail_after_r: z.number().positive(),
      trail_atr: z.object({ calm: z.number().positive(), stressed: z.number().positive() }),
      harvest: z.object({
        enabled: z.boolean(),
        max_extra_hours: z
          .number()
          .nonnegative()
          .max(24 * 7),
        max_rsi: z.number().min(50).max(100),
      }),
      review: z.object({
        enabled: z.boolean(),
        max_per_day: z.number().int().nonnegative(),
        cooldown_minutes: z.number().int().nonnegative(),
        held_material_min: z.number().min(0).max(1),
        exit_prob: z.number().min(0.5).max(1),
        kill_prob: z.number().min(0.5).max(1),
      }),
      watch_research: z.object({ enabled: z.boolean(), every_hours: z.number().positive() }),
      earnings_derisk: z.boolean(),
      rotation: z.object({
        enabled: z.boolean(),
        min_horizon_fraction: z.number().min(0).max(1),
        max_abs_r: z.number().positive(),
        min_candidate_win: z.number().min(0).max(1),
      }),
    })
    .default({
      enabled: false,
      breakeven_at_r: 1,
      trail_after_r: 1.5,
      trail_atr: { calm: 1.2, stressed: 0.8 },
      harvest: { enabled: false, max_extra_hours: 0, max_rsi: 80 },
      review: {
        enabled: false,
        max_per_day: 0,
        cooldown_minutes: 120,
        held_material_min: 0.5,
        exit_prob: 0.6,
        kill_prob: 0.7,
      },
      watch_research: { enabled: false, every_hours: 24 },
      earnings_derisk: false,
      rotation: { enabled: false, min_horizon_fraction: 0.5, max_abs_r: 0.25, min_candidate_win: 0.6 },
    }),
  /**
   * ADR-058: dynamic universe. The scout hot-ports any Alpaca asset that passes the code screen when a catalyst about
   * it reaches Tier 2; research-named related symbols are watched. The doctrine watchlists stay the permanent core.
   */
  universe: z
    .object({
      enabled: z.boolean(),
      /** news intake: only watched symbols, or the whole Alpaca news stream behind the Tier 0.5 prefilter */
      news_scope: z.enum(["watchlist", "all"]),
      max_dynamic: z.number().int().min(0).max(200),
      ttl_days: z.number().positive().max(60),
      min_price_usd: z.number().nonnegative(),
      min_dollar_volume_usd: z.record(z.enum(["CRYPTO", "EQUITIES"]), z.number().nonnegative()),
      max_spread_bps: z.record(z.enum(["CRYPTO", "EQUITIES"]), z.number().positive()),
      max_ports_per_day: z.number().int().nonnegative(),
      max_watch: z.number().int().nonnegative(),
      prefilter_min_score: z.number(),
      /** headlines about non-priority symbols allowed into Tier 1 per UTC day (neuron guard) */
      max_open_intake_per_day: z.number().int().nonnegative(),
    })
    .default({
      enabled: false,
      news_scope: "watchlist",
      max_dynamic: 0,
      ttl_days: 7,
      min_price_usd: 5,
      min_dollar_volume_usd: { CRYPTO: 1_000_000, EQUITIES: 20_000_000 },
      max_spread_bps: { CRYPTO: 40, EQUITIES: 20 },
      max_ports_per_day: 0,
      max_watch: 0,
      prefilter_min_score: 2,
      max_open_intake_per_day: 0,
    }),
});

export type Doctrine = z.infer<typeof DoctrineSchema>;

/**
 * Doctrine may only be tighter than the constitution (CLAUDE.md §2, U3).
 * Returns a list of human-readable violations; empty means OK. Pure.
 */
export function doctrineViolations(d: Doctrine, c: Constitution): string[] {
  const v: string[] = [];
  const h = c.hard_limits;

  for (const [name, r] of Object.entries(d.rungs)) {
    if (r.per_trade_risk > h.max_per_trade_risk_pct) v.push(`${name}.per_trade_risk > constitution`);
    if (r.total_heat > h.max_total_heat_pct) v.push(`${name}.total_heat > constitution`);
    if (r.max_position_notional > h.max_position_notional_pct)
      v.push(`${name}.max_position_notional > constitution`);
    if (r.max_positions > h.max_concurrent_positions) v.push(`${name}.max_positions > constitution`);
    if (r.equity_max !== null && r.equity_max <= r.equity_min) v.push(`${name} equity band is empty`);
  }

  const b = d.breakers;
  if (b.red_daily_loss > h.max_daily_loss_pct) v.push("breakers.red_daily_loss > constitution");
  if (b.red_drawdown > h.red_breaker_max_drawdown_pct) v.push("breakers.red_drawdown > constitution");
  if (!(b.yellow_drawdown < b.orange_drawdown && b.orange_drawdown < b.red_drawdown)) {
    v.push("breakers must be ordered yellow < orange < red");
  }
  if (!(b.multipliers.GREEN >= b.multipliers.YELLOW && b.multipliers.YELLOW >= b.multipliers.ORANGE)) {
    v.push("breaker multipliers must be non-increasing");
  }

  if (b.paper_auto_unlock_hours < h.paper_red_auto_unlock_min_hours) {
    v.push("breakers.paper_auto_unlock_hours < constitution minimum");
  }
  const paperStop = d.accounts.PAPER?.autonomy_stop;
  if (paperStop !== undefined && ![0, 2, 4].includes(paperStop))
    v.push("PAPER autonomy_stop must be 0, 2 or 4");
  const liveStop = d.accounts.LIVE?.autonomy_stop;
  if (liveStop !== undefined && ![0, 3, 4].includes(liveStop)) v.push("LIVE autonomy_stop must be 0, 3 or 4");
  if (d.sizing.min_stop_atr_multiple < h.min_stop_atr_multiple)
    v.push("sizing.min_stop_atr_multiple < constitution");
  if (d.sizing.edge_gate.p_full <= d.sizing.edge_gate.p_zero) v.push("edge_gate.p_full must exceed p_zero");
  if (d.budgets.hard_stop_fraction > h.free_tier_hard_stop_fraction)
    v.push("budgets.hard_stop_fraction > constitution");
  if (d.budgets.thrift_fraction >= d.budgets.hard_stop_fraction)
    v.push("budgets.thrift_fraction must be < hard_stop_fraction");

  const n = d.budgets.workers_ai_neurons_per_day;
  if (n.tier1 + n.tier2 + n.tier3_fallback + n.clairic + n.reserve > n.total_free)
    v.push("neuron allocations exceed total_free");

  const live = d.accounts.LIVE;
  if (live && live.autonomy_stop > h.max_live_autonomy_stop_without_ratification) {
    v.push("LIVE autonomy_stop exceeds the unratified maximum; ratification must be recorded in the PR");
  }

  for (const s of d.strategies) {
    if (s.accounts.includes("LIVE") && !c.allowed.live_arenas.includes(s.arena)) {
      v.push(`strategy ${s.id} trades ${s.arena} on LIVE, which the constitution forbids`);
    }
    const schema = STRATEGY_PARAMS[s.id];
    if (schema) {
      const r = schema.safeParse(s.params ?? {});
      if (!r.success)
        v.push(
          `strategy ${s.id}: bad params — ${r.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "params"}: ${i.message}`)
            .join("; ")}`,
        );
    }
    if (s.params?.instrument === "inverse_etf_1x") {
      for (const sym of s.universe ?? [])
        if (!c.allowed.inverse_etfs_1x.includes(sym))
          v.push(`strategy ${s.id}: ${sym} is not a constitution-approved 1x inverse ETF`);
    }
    if (d.lab.strategies.includes(s.id) && s.arena === "OPTIONS")
      v.push(`lab: ${s.id} is an options strategy (the options lab is a virtual ledger)`);
    if (s.arena === "OPTIONS") {
      const st = s.params?.structure;
      if (typeof st !== "string" || !c.allowed.options_structures_paper.includes(st)) {
        v.push(`strategy ${s.id}: options structure ${String(st)} is not allowed by the constitution`);
      }
    }
  }

  for (const id of d.lab.strategies)
    if (!d.strategies.some((s) => s.id === id)) v.push(`lab: unknown strategy ${id}`);

  if (d.llm_routing.require_cross_family) {
    const fam = (hop: { provider: string; model: string }) =>
      d.llm_routing.families[`${hop.provider}/${hop.model}`] ?? d.llm_routing.families[hop.provider];
    for (const hop of [...d.llm_routing.bull_chain, ...d.llm_routing.bear_chain]) {
      if (!fam(hop)) v.push(`llm_routing: no family declared for ${hop.provider}/${hop.model}`);
    }
  }

  return v;
}
