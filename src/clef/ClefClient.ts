import { z } from "zod";

/**
 * Cloudflare Clef decision models on Workers AI (verified live 2026-10-22).
 * Request:  { model: "clef" | "clef-flash", state, questions: { id: { type, instructions, criteria? } } }
 * Response: { model, answers: { id: NoulAnswer | ChoiceAnswer | ScoreAnswer }, usage: { input_tokens, output_tokens } }
 * Context window 24,576 tokens (questions + state); ≤64 questions; output tokens are not billed.
 */
export type ClefModel = "clef-flash" | "clef";

export type ClefQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().optional(),
});
const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().optional(),
});

export const ClefResultSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.discriminatedUnion("type", [NoulAnswer, ChoiceAnswer, ScoreAnswer])),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
    .partial(),
});
export type ClefResult = z.infer<typeof ClefResultSchema>;
export type ClefAnswer = ClefResult["answers"][string];

export const CLEF_CONTEXT_TOKENS = 24_576;
export const CLEF_MAX_QUESTIONS = 64;

/** Conservative pre-call token estimate (≈3.2 chars/token for English + JSON punctuation). */
export function estimateTokens(state: unknown, questions: Record<string, ClefQuestion>): number {
  return Math.ceil((JSON.stringify(state).length + JSON.stringify(questions).length) / 3.2);
}

export interface ClefApi {
  run(model: ClefModel, state: unknown, questions: Record<string, ClefQuestion>): Promise<ClefResult>;
}

/** The slice of the Workers AI binding we use (kept structural so Node tests needn't load Workers types). */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

/**
 * Reject if `p` has not settled within `ms` (audit 2026-10-24: Workers AI calls had no timeout, so one hung call
 * could hold the pulse — and the heartbeat — indefinitely). The underlying call is not cancelled, only abandoned.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => {
    if (t !== null) clearTimeout(t);
  });
}

export const CLEF_TIMEOUT_MS = 45_000;

/** Thin binding wrapper; validates the response so a format change fails closed. */
export class WorkersAiClef implements ClefApi {
  constructor(private readonly ai: AiBinding) {}

  async run(model: ClefModel, state: unknown, questions: Record<string, ClefQuestion>): Promise<ClefResult> {
    const n = Object.keys(questions).length;
    if (n === 0 || n > CLEF_MAX_QUESTIONS) throw new Error(`clef: ${n} questions (1–${CLEF_MAX_QUESTIONS})`);
    const raw = await withTimeout(
      this.ai.run(`@cf/cloudflare/${model}`, { model, state, questions }),
      CLEF_TIMEOUT_MS,
      model,
    );
    return conformAnswers(ClefResultSchema.parse(raw), questions);
  }
}

/**
 * Audit W2-09: hold each answer to the question it answers. A score is clamped to its scale (0 … criteria−1); a
 * choice that is not one of the offered options, or an answer of the wrong type, is dropped — the interpreters treat
 * a missing answer as a failure, so a malformed reply fails closed instead of feeding a decision.
 */
export function conformAnswers(r: ClefResult, questions: Record<string, ClefQuestion>): ClefResult {
  const answers: ClefResult["answers"] = {};
  for (const [id, a] of Object.entries(r.answers)) {
    const q = questions[id];
    if (!q || q.type !== a.type) continue;
    if (a.type === "score" && q.type === "score") {
      answers[id] = { ...a, score: Math.min(Math.max(a.score, 0), q.criteria.length - 1) };
    } else if (a.type === "choice" && q.type === "choice") {
      if (Object.hasOwn(q.criteria, a.choice)) answers[id] = a;
    } else answers[id] = a;
  }
  return { ...r, answers };
}

export const noul = (a: ClefAnswer | undefined): number | null => (a?.type === "noul" ? a.noul : null);
export const choice = (a: ClefAnswer | undefined): string | null => (a?.type === "choice" ? a.choice : null);
export const score = (a: ClefAnswer | undefined): number | null => (a?.type === "score" ? a.score : null);
