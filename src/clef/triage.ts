import type { Doctrine } from "../contracts/doctrine.ts";
import { type ClefQuestion, type ClefResult, choice, noul, score } from "./ClefClient.ts";

/**
 * Tier 1 triage (CLAUDE.md §3): one batched clef-flash call over up to `batch_max_items` queued candidates.
 * Pure: builds the request and interprets the answers. External text is passed as *data* inside `state`;
 * Clef only returns typed probabilities, so a hostile headline can't make it do anything.
 */
export interface TriageItem {
  candidateId: string;
  kind: string; // news | gdelt | edgar
  symbols: string[];
  headline: string;
  summary: string;
  source: string;
  ageMinutes: number;
}

export const ESCALATE_LEVELS = ["Reject", "Watchlist", "Shadow", "Deep"] as const;
export const TIER1_PROMPT_VERSION = "tier1@1";

export function buildTier1(items: TriageItem[], context: Record<string, unknown>) {
  const state = {
    task: "Triage market news for a small autonomous trading account (crypto spot + US equities, long-only, holds 1–3 days).",
    context,
    items: items.map((it, i) => ({
      i,
      kind: it.kind,
      symbols: it.symbols,
      source: it.source,
      age_minutes: it.ageMinutes,
      headline: it.headline,
      summary: it.summary.slice(0, 280),
    })),
  };
  const questions: Record<string, ClefQuestion> = {};
  items.forEach((_, i) => {
    questions[`i${i}.material`] = {
      type: "noul",
      instructions: `Item ${i}: is this a material, tradeable catalyst for its symbols within the next 72 hours (not routine coverage, lists, or opinion)?`,
    };
    questions[`i${i}.direction`] = {
      type: "choice",
      instructions: `Item ${i}: most likely price direction for its symbols`,
      criteria: { up: "bullish", down: "bearish", unclear: "no clear direction" },
    };
    questions[`i${i}.escalate`] = {
      type: "score",
      instructions: `Item ${i}: priority for deeper structural analysis by the trading system`,
      criteria: [...ESCALATE_LEVELS],
    };
  });
  return { state, questions };
}

export interface TriageDecision {
  candidateId: string;
  material: number;
  direction: string;
  escalate: number; // 0..3 probability-weighted
  promote: boolean;
}

/** Missing or malformed answers drop the item (fail closed). */
export function interpretTier1(items: TriageItem[], result: ClefResult, d: Doctrine): TriageDecision[] {
  const t = d.funnel.tier1;
  return items.map((it, i) => {
    const m = noul(result.answers[`i${i}.material`]);
    const dir = choice(result.answers[`i${i}.direction`]);
    const esc = score(result.answers[`i${i}.escalate`]);
    const ok = m !== null && dir !== null && esc !== null;
    return {
      candidateId: it.candidateId,
      material: m ?? 0,
      direction: dir ?? "unclear",
      escalate: esc ?? 0,
      promote: ok && (m as number) >= t.escalate_threshold && (esc as number) >= t.min_escalate_score,
    };
  });
}

/** Neurons for a call, from Clef's reported input tokens (output is free). */
export function neuronsFor(model: "clef-flash" | "clef", inputTokens: number, d: Doctrine): number {
  return (inputTokens * (d.budgets.neurons_per_mtok[model] ?? 0)) / 1_000_000;
}
