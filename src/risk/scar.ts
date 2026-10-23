import { z } from "zod";

/**
 * Scar tissue (docs/ARCHITECTURE.md §8, ADR-033): operator-merged lessons from ≥3 episodic postmortems.
 * `hard_filter` rules compile to a Tier 0 veto checked before every entry (and before convening the court);
 * `context` rules are passed to Tier 2 / the court as lessons. Rules only ever remove trades, never add or
 * enlarge them. Pure.
 */

export const FACT_FIELDS = [
  "symbol",
  "arena",
  "strategy_id",
  "origin",
  "posture",
  "regime_score",
  "utc_hour",
  "utc_dow",
  "catalyst_source",
] as const;
export type FactField = (typeof FACT_FIELDS)[number];
export type Facts = Partial<Record<FactField, string | number | null>>;

const Scalar = z.union([z.string(), z.number()]);
const Condition = z.object({
  field: z.enum(FACT_FIELDS),
  op: z.enum(["==", "!=", ">", ">=", "<", "<=", "in", "not_in"]),
  value: z.union([Scalar, z.array(Scalar).min(1)]),
});
export type Condition = z.infer<typeof Condition>;

export const ScarRuleSchema = z
  .object({
    id: z.string().regex(/^SCAR-\d{3,}$/),
    kind: z.enum(["hard_filter", "context"]),
    arena: z.enum(["CRYPTO", "EQUITIES", "OPTIONS"]).optional(),
    rule: z.string().min(10).max(300),
    expression: z.object({ all: z.array(Condition).min(1).max(6), action: z.literal("reject") }).optional(),
    evidence: z.array(z.string().min(1)).min(3), // ≥3 episodic matches, cited by contract_id
    added: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expires: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .refine((r) => r.kind !== "hard_filter" || r.expression !== undefined, {
    message: "hard_filter rules need an expression",
  });
export type ScarRule = z.infer<typeof ScarRuleSchema>;

export const ScarTissueSchema = z
  .object({ version: z.number().int(), rules: z.array(ScarRuleSchema).nullable() })
  .transform((s) => ({ version: s.version, rules: s.rules ?? [] }))
  .refine((s) => new Set(s.rules.map((r) => r.id)).size === s.rules.length, {
    message: "duplicate scar rule id",
  });
export type ScarTissue = z.infer<typeof ScarTissueSchema>;

function test(c: Condition, facts: Facts): boolean {
  const v = facts[c.field];
  if (v === undefined || v === null) return false; // unknown facts never match (a scar only removes trades it can see)
  const list = Array.isArray(c.value) ? c.value : [c.value];
  switch (c.op) {
    case "==":
      return v === list[0];
    case "!=":
      return v !== list[0];
    case "in":
      return list.includes(v);
    case "not_in":
      return !list.includes(v);
    default: {
      const a = Number(v);
      const b = Number(list[0]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return c.op === ">" ? a > b : c.op === ">=" ? a >= b : c.op === "<" ? a < b : a <= b;
    }
  }
}

const active = (r: ScarRule, today: string, arena: unknown) =>
  (r.expires === undefined || today <= r.expires) && (r.arena === undefined || r.arena === arena);

/** Hard-filter rules that veto this entry. */
export function scarVetoes(rules: readonly ScarRule[], facts: Facts, today: string): ScarRule[] {
  return rules.filter(
    (r) =>
      r.kind === "hard_filter" &&
      r.expression !== undefined &&
      active(r, today, facts.arena) &&
      r.expression.all.every((c) => test(c, facts)),
  );
}

/** Context lessons for an arena (passed to Tier 2 / the court as data). */
export function scarLessons(rules: readonly ScarRule[], arena: string, today: string): string[] {
  return rules
    .filter((r) => r.kind === "context" && active(r, today, arena))
    .map((r) => `${r.id}: ${r.rule}`);
}

/** Catalyst reputation key: news by provider, everything else by kind (ADR-033). */
export function reputationKey(kind: string, source: string): string {
  const k = (kind || "unknown").toLowerCase().slice(0, 30);
  return k === "news" ? `news:${(source || "unknown").toLowerCase().slice(0, 40)}` : k;
}
