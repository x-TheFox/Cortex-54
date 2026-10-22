import { z } from "zod";
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
  }),
  sizing: z.object({
    min_stop_atr_multiple: z.number().positive(),
    bear_disagreement: z.object({ floor: Fraction, max_penalty: Fraction }),
    reputation_weight: z.object({
      min: z.number().positive(),
      max: z.number().positive(),
      min_signals_before_adjusting: z.number().int().nonnegative(),
    }),
    edge_gate: z.object({ p_zero: Fraction, p_full: Fraction }),
    correlation_guard: z.object({ lookback_days: z.number().int().positive(), max_corr: Fraction }),
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
    repeg_on_move_atr: z.number().positive(),
    exit_collar_bps: z.number().positive(),
    no_entry_last_minutes_of_session: z.number().int().nonnegative(),
    earnings_blackout_hours: z.number().int().nonnegative(),
    max_spread_bps: z.record(Arena, z.number().positive()),
    reservation_ttl_seconds: z.number().int().positive(),
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
    tier3: z.object({
      max_sprints_per_day: z.number().int().nonnegative(),
      min_structural_score: z.number().min(0).max(100),
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
    require_cross_family: z.boolean(),
    max_retries_per_provider: z.number().int().min(0).max(3),
    timeout_ms: z.number().int().positive(),
  }),
  regime_gates: z.object({
    crypto_composite_min_for_longs: z.number().min(0).max(100),
    equity_postures_allowing_entries: z.array(z.string()),
  }),
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
  if (n.tier1 + n.tier2 + n.tier3_fallback + n.reserve > n.total_free)
    v.push("neuron allocations exceed total_free");

  const live = d.accounts.LIVE;
  if (live && live.autonomy_stop > h.max_live_autonomy_stop_without_ratification) {
    v.push("LIVE autonomy_stop exceeds the unratified maximum; ratification must be recorded in the PR");
  }

  for (const s of d.strategies) {
    if (s.accounts.includes("LIVE") && !c.allowed.live_arenas.includes(s.arena)) {
      v.push(`strategy ${s.id} trades ${s.arena} on LIVE, which the constitution forbids`);
    }
  }

  if (d.llm_routing.require_cross_family) {
    const fam = (hop: { provider: string; model: string }) =>
      d.llm_routing.families[`${hop.provider}/${hop.model}`] ?? d.llm_routing.families[hop.provider];
    for (const hop of [...d.llm_routing.bull_chain, ...d.llm_routing.bear_chain]) {
      if (!fam(hop)) v.push(`llm_routing: no family declared for ${hop.provider}/${hop.model}`);
    }
  }

  return v;
}
