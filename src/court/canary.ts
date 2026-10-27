import type { Doctrine } from "../contracts/doctrine.ts";
import { BullSchema } from "./court.ts";
import { buildEvidence, evidenceForModels } from "./evidence.ts";
import { extractJson, type LlmProvider } from "./llm.ts";
import { BULL_PROMPT_VERSION, BULL_SCHEMA, BULL_SYSTEM, untrusted } from "./prompts.ts";

/**
 * Model drift canary (ADR-070; dossier MLP0-012). Free models change under us without notice: a silent weight update,
 * a JSON mode that stops working, a new refusal habit, a latency cliff. Once a week every hop in the court chains
 * gets the same golden bull prompt on a fixed synthetic case; the report says per model whether it answered, whether
 * the answer passed the court's own schema, and how long it took. Measurement only (the router already fails over);
 * a model that fails twice in a row is the cue to edit the chains.
 */

export interface CanaryResult {
  provider: string;
  model: string;
  ok: boolean;
  schema_ok: boolean;
  ms: number;
  error?: string;
}

export function goldenCase(now: number) {
  const bars = Array.from({ length: 60 }, (_, i) => {
    const c = 100 + i * 0.4 + (i % 3 === 0 ? -0.6 : 0.3);
    return { t: now - (60 - i) * 86_400_000, o: c - 0.2, h: c + 1.1, l: c - 1.2, c, v: 1000 };
  });
  return buildEvidence({
    symbol: "CANARY/USD",
    arena: "CRYPTO",
    bars,
    bid: 124,
    ask: 124.05,
    now,
    regime: { crypto: { posture: "NEW_ENTRY_ALLOWED", score: 60 } },
    world: null,
    catalyst: {
      candidateId: "canary",
      kind: "news",
      headline: "Exchange lists CANARY with a USD pair; volume triples on day one",
      source: "canary",
      url: null,
      ageMinutes: 20,
      tier1: { material: 0.8, direction: "up", escalate: 2 },
    },
    held: [],
  });
}

export function hopsOf(d: Doctrine): { provider: string; model: string }[] {
  const r = d.llm_routing;
  const all = [...r.bull_chain, ...r.bear_chain, ...r.panel.chain];
  return [...new Map(all.map((h) => [`${h.provider}/${h.model}`, h])).values()];
}

export async function runCanary(
  providers: Partial<Record<string, LlmProvider>>,
  hops: { provider: string; model: string }[],
  now: number,
  clock: () => number = () => Date.now(),
  timeoutMs = 60_000,
): Promise<{ prompt: string; results: CanaryResult[] }> {
  const e = goldenCase(now);
  if (!e) throw new Error("golden case failed to build");
  const user = `Evidence JSON (ids for receipts: ${e.receipts.map((r) => r.evidence_id).join(", ")}):\n${untrusted("evidence", JSON.stringify(evidenceForModels(e)))}`;
  const results: CanaryResult[] = [];
  for (const h of hops) {
    const p = providers[h.provider];
    if (!p) continue;
    const t0 = clock();
    try {
      const res = await p.complete(
        h.model,
        {
          system: BULL_SYSTEM,
          user,
          maxOutputTokens: 1500,
          schema: BULL_SCHEMA as unknown as Record<string, unknown>,
        },
        timeoutMs,
      );
      let schemaOk = false;
      let err: string | undefined;
      try {
        BullSchema.parse(extractJson(res.text));
        schemaOk = true;
      } catch (x) {
        err = `schema: ${String(x).slice(0, 120)}`;
      }
      results.push({ ...h, ok: true, schema_ok: schemaOk, ms: clock() - t0, ...(err ? { error: err } : {}) });
    } catch (x) {
      results.push({ ...h, ok: false, schema_ok: false, ms: clock() - t0, error: String(x).slice(0, 160) });
    }
  }
  return { prompt: BULL_PROMPT_VERSION, results };
}
