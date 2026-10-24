import { z } from "zod";
import type { AiBinding } from "./ClefClient.ts";

/**
 * Cloudflare Clairic (ADR-043): an extraction model on Workers AI (preview, verified live 2026-10-24). It reads text
 * and returns typed values with confidences, billed on input only ($0.10/M tokens ≈ 9,091 neurons/M). We use it to
 * pull the numbers out of a promoted catalyst (surprise %, guidance %, deal size, dates) so the court debates facts
 * instead of re-reading prose. Model output is data: only values at or above the confidence bar reach the court as
 * facts, the rest are named as uncertain, and Clairic's own move estimate is labelled LOW confidence.
 *
 * Request:  { model: "clairic", state, fields: { id: { type, instructions?, decimals?, unit?, min?, max?, step? } },
 *             reference_date? }
 * Response: { answers: { id: { value, confidence?, mean?, p10?, p90?, ... } }, usage: { input_tokens, passes } }
 */
export type ClairicField =
  | { type: "text"; instructions: string }
  | { type: "date"; instructions: string }
  | { type: "number"; instructions: string; decimals?: number; unit?: string }
  | { type: "estimate"; instructions: string; min: number; max: number; step: number };

const Answer = z
  .object({
    value: z.union([z.string(), z.number(), z.array(z.unknown()), z.null()]).optional(),
    confidence: z.number().nullable().optional(),
    mean: z.number().nullable().optional(),
    p10: z.number().nullable().optional(),
    p90: z.number().nullable().optional(),
  })
  .loose();

export const ClairicResultSchema = z.object({
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }).partial().loose().optional(),
});
export type ClairicResult = z.infer<typeof ClairicResultSchema>;

export interface ClairicApi {
  run(state: string, fields: Record<string, ClairicField>, referenceDate: string): Promise<ClairicResult>;
}

export class WorkersAiClairic implements ClairicApi {
  constructor(private readonly ai: AiBinding) {}
  async run(
    state: string,
    fields: Record<string, ClairicField>,
    referenceDate: string,
  ): Promise<ClairicResult> {
    const raw = await this.ai.run("@cf/cloudflare/clairic", {
      model: "clairic",
      state,
      fields,
      reference_date: referenceDate,
    });
    return ClairicResultSchema.parse(raw);
  }
}

/** The fixed schema of catalyst facts. Versioned like a prompt: changing it means bumping the version. */
export const FACTS_VERSION = "facts@1";
export const FACT_FIELDS: Record<string, ClairicField> = {
  entity: { type: "text", instructions: "The main company, coin or asset the text is about" },
  event_type: {
    type: "text",
    instructions:
      "One or two words for the event: earnings, guidance, deal, listing, hack, regulation, lawsuit, macro, product, other",
  },
  revenue_surprise_pct: {
    type: "number",
    decimals: 2,
    unit: "percent",
    instructions: "Reported revenue versus the consensus estimate, percent difference; null if not stated",
  },
  eps_surprise_pct: {
    type: "number",
    decimals: 2,
    unit: "percent",
    instructions: "Reported EPS versus the consensus estimate, percent difference; null if not stated",
  },
  guidance_vs_consensus_pct: {
    type: "number",
    decimals: 2,
    unit: "percent",
    instructions:
      "Forward guidance midpoint versus the consensus estimate, percent difference; null if not stated",
  },
  deal_value_usd_m: {
    type: "number",
    decimals: 1,
    unit: "USD millions",
    instructions: "Value of any deal, raise, buyback, hack or fine mentioned, in millions of US dollars",
  },
  price_move_mentioned_pct: {
    type: "number",
    decimals: 2,
    unit: "percent",
    instructions: "Price change of the asset stated in the text (e.g. 'shares rose 4%'), signed",
  },
  event_date: { type: "date", instructions: "The date the event happened or was announced" },
  next_day_move_estimate_pct: {
    type: "estimate",
    min: -20,
    max: 20,
    step: 0.5,
    instructions: "Estimated price change of the asset over the next trading day, percent",
  },
};

export interface CatalystFacts {
  source: "clairic";
  version: string;
  min_confidence: number;
  /** Values at or above the confidence bar. */
  values: Record<string, string | number>;
  /** Fields the text mentioned but Clairic was not sure about. */
  uncertain: string[];
  /** Clairic's own guess at the next move: LOW confidence, like Kronos. */
  move_estimate: { confidence: "LOW"; mean: number; p10: number | null; p90: number | null } | null;
}

/** Pure: keep confident values, name the uncertain ones, label the estimate. */
export function interpretFacts(r: ClairicResult, minConfidence: number): CatalystFacts {
  const values: Record<string, string | number> = {};
  const uncertain: string[] = [];
  let move: CatalystFacts["move_estimate"] = null;
  for (const [k, a] of Object.entries(r.answers)) {
    if (!(k in FACT_FIELDS)) continue;
    if (FACT_FIELDS[k]?.type === "estimate") {
      const mean = typeof a.mean === "number" ? a.mean : typeof a.value === "number" ? a.value : null;
      if (mean !== null && Number.isFinite(mean))
        move = {
          confidence: "LOW",
          mean: Math.round(mean * 100) / 100,
          p10: a.p10 ?? null,
          p90: a.p90 ?? null,
        };
      continue;
    }
    const v = a.value;
    if (v === null || v === undefined || Array.isArray(v) || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if ((a.confidence ?? 0) >= minConfidence) values[k] = typeof v === "string" ? v.slice(0, 80) : v;
    else uncertain.push(k);
  }
  return {
    source: "clairic",
    version: FACTS_VERSION,
    min_confidence: minConfidence,
    values,
    uncertain,
    move_estimate: move,
  };
}
