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
    job: z.enum(["crypto-regime", "equity-posture", "world-intel"]),
    produced_at: z.number().int(),
    run_url: z.url().nullable(),
    items: z.array(BatchItemSchema).min(1).max(20),
    posture: PostureSchema.nullable(),
  })
  .refine((b) => (b.job === "world-intel") === (b.posture === null), {
    message: "posture is required for regime jobs and must be null for world-intel",
  });
export type Batch = z.infer<typeof BatchSchema>;

/** Max raw body the worker accepts (keeps JSON parsing well inside the 10 ms CPU budget). */
export const MAX_BATCH_BYTES = 64 * 1024;
