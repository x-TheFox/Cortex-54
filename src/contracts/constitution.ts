import { z } from "zod";

const Fraction = z.number().gt(0).lte(1);

export const ConstitutionSchema = z.object({
  $comment: z.string().optional(),
  version: z.number().int().positive(),
  untouchables: z
    .array(z.object({ id: z.string().regex(/^U\d+$/), name: z.string(), rule: z.string().min(10) }))
    .length(8),
  hard_limits: z.object({
    max_per_trade_risk_pct: Fraction,
    max_total_heat_pct: Fraction,
    max_position_notional_pct: Fraction,
    max_concurrent_positions: z.number().int().positive(),
    max_daily_loss_pct: Fraction,
    red_breaker_max_drawdown_pct: Fraction,
    min_stop_atr_multiple: z.number().positive(),
    max_orders_per_day_per_account: z.number().int().positive(),
    max_live_autonomy_stop_without_ratification: z.number().int().min(0).max(4),
    paper_red_auto_unlock_min_hours: z.number().positive(),
    free_tier_hard_stop_fraction: Fraction,
    max_quote_staleness_seconds: z.number().int().positive(),
    max_reconcile_age_seconds: z.number().int().positive(),
  }),
  allowed: z.object({
    account_types: z.array(z.literal("cash")).min(1),
    live_arenas: z.array(z.enum(["CRYPTO", "EQUITIES", "OPTIONS"])),
    paper_arenas: z.array(z.enum(["CRYPTO", "EQUITIES", "OPTIONS"])),
    order_sides: z.array(z.string()),
    options_structures_paper: z.array(z.string()),
    options_structures_live: z.array(z.string()),
  }),
  forbidden: z.array(z.string()).min(1),
});

export type Constitution = z.infer<typeof ConstitutionSchema>;
