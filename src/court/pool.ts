import { z } from "zod";
import type { Doctrine } from "../contracts/doctrine.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { type Fetcher, type LlmProvider, LlmRouter, OpenAICompatProvider } from "./llm.ts";
import { lineage, normalizeUrl } from "./models.ts";

/**
 * The model pool (ADR-072, replaces the two-endpoint BYOK of 2026-10-26 the same day). The user adds any number of
 * endpoints, each OpenAI- or Anthropic-compatible, free or paid, with the models they enabled there. Together with
 * the built-in free providers (Gemini / Groq / NIM / OpenRouter keys and their verified models), every model is one
 * pool entry. The court takes models from the pool in round-robin order (spreading load across free tiers), and every
 * other model is a fallback when one fails. Bull and bear must come from different families: different lineages when
 * the pool has several, different models when it has only one lineage. A pool with a single model can still run if
 * the user accepts the same model on both sides; the app warns that the bear then catches fewer bad trades.
 */

export const EndpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
  name: z.string().min(1).max(60),
  format: z.enum(["openai", "anthropic"]),
  url: z.string().regex(/^https?:\/\//),
  key: z.string().max(2000).default(""),
  /** enabled models (the user picks from discovery, or types names when the endpoint can't list them) */
  models: z.array(z.string().min(1).max(200)).max(50).default([]),
  tier: z.enum(["free", "paid", "local"]).default("paid"),
  /** optional calls/day cap (a free tier's request limit with margin) */
  daily_cap: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

export const PoolPrefsSchema = z.object({
  /** free_first: free and local models first, paid as fallback; paid_first: the reverse; mixed: one rotation */
  prefer: z.enum(["free_first", "paid_first", "mixed"]).default("free_first"),
  /** round robin across the pool (spreads free-tier quotas); off = always try in listed order */
  round_robin: z.boolean().default(true),
  /** the user accepted a same-model bear when the pool has only one model */
  allow_same_model: z.boolean().default(false),
});
export type PoolPrefs = z.infer<typeof PoolPrefsSchema>;

export const PoolConfigSchema = z.object({
  endpoints: z.array(EndpointSchema).max(50).default([]),
  prefs: PoolPrefsSchema.default({ prefer: "free_first", round_robin: true, allow_same_model: false }),
});
export type PoolConfig = z.infer<typeof PoolConfigSchema>;

/** The cloud worker gets the pool as one secret (LLM_POOL, JSON). A malformed value is ignored, never half-used. */
export function parsePool(json: string | undefined): PoolConfig {
  if (!json) return PoolConfigSchema.parse({});
  try {
    return PoolConfigSchema.parse(JSON.parse(json));
  } catch {
    return PoolConfigSchema.parse({});
  }
}

export interface PoolEntry {
  provider: string;
  model: string;
  tier: "free" | "paid" | "local";
  family: string;
  /** what the user sees: endpoint name or built-in provider */
  source: string;
}

export interface PoolReport {
  entries: PoolEntry[];
  models: number;
  lineages: string[];
  /** plain-language problems; `level: "block"` means the court can't run */
  notes: { level: "ok" | "warn" | "block"; text: string }[];
}

const rank = (t: PoolEntry["tier"], prefer: PoolPrefs["prefer"]) =>
  prefer === "mixed" ? 0 : (t === "paid") === (prefer === "free_first") ? 1 : 0;

/** strip routing prefixes and free-tier suffixes so the same model on two endpoints counts once */
export const modelKey = (m: string) =>
  m
    .toLowerCase()
    .replace(/:free$/, "")
    .split("/")
    .pop() ?? m;

export function endpointProvider(e: Endpoint, fetcher?: Fetcher): LlmProvider {
  const name = `ep:${e.id}`;
  if (e.format === "anthropic") {
    const url = normalizeUrl("anthropic", e.url);
    return new AnthropicProvider(e.key, fetcher, {
      baseURL: url,
      name,
      // refusal fallbacks exist only on api.anthropic.com for a few models; a proxy or another model would 400
      fallbacks: url === "https://api.anthropic.com" && e.models.every((m) => FALLBACK_MODELS.test(m)),
    });
  }
  return new OpenAICompatProvider(
    name,
    normalizeUrl("openai", e.url),
    e.key || "none",
    { jsonMode: true, adaptive: true, minOutputTokens: 4096 },
    fetcher ?? ((u: string, i?: RequestInit) => fetch(u, i)),
  );
}
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

/**
 * Build the pool from the built-in providers (with the doctrine's verified free hops) and the user's endpoints, and
 * return the doctrine whose bull / bear / panel chains are that pool in preference order. Pure.
 */
export function buildPool(
  d: Doctrine,
  builtin: Partial<Record<string, LlmProvider>>,
  cfg: PoolConfig,
  fetcher?: Fetcher,
): { providers: Partial<Record<string, LlmProvider>>; d: Doctrine; report: PoolReport } {
  const r = d.llm_routing;
  const providers: Partial<Record<string, LlmProvider>> = { ...builtin };
  const raw: Omit<PoolEntry, "family">[] = [];
  const seen = new Set<string>();
  const add = (e: Omit<PoolEntry, "family">) => {
    const k = `${e.provider}/${e.model}`;
    if (!seen.has(k)) {
      seen.add(k);
      raw.push(e);
    }
  };
  // built-in free hops in the doctrine's verified order (only providers with a key)
  for (const h of [...r.bull_chain, ...r.bear_chain, ...r.panel.chain])
    if (builtin[h.provider]) add({ provider: h.provider, model: h.model, tier: "free", source: h.provider });
  const caps: Record<string, number> = { ...r.daily_call_caps };
  for (const e of cfg.endpoints) {
    if (!e.enabled || e.models.length === 0) continue;
    const p = `ep:${e.id}`;
    providers[p] = endpointProvider(e, fetcher);
    if (e.daily_cap) caps[p] = e.daily_cap;
    for (const m of e.models) add({ provider: p, model: m, tier: e.tier, source: e.name });
  }
  const prefer = cfg.prefs.prefer;
  const ordered = raw
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.tier, prefer) - rank(b.e.tier, prefer) || a.i - b.i)
    .map((x) => x.e);

  const famOf = (e: Omit<PoolEntry, "family">) =>
    r.families[`${e.provider}/${e.model}`] ??
    (builtin[e.provider] ? r.families[e.provider] : undefined) ??
    lineage(e.model);
  const lineages = [...new Set(ordered.map(famOf))];
  const distinctModels = new Set(ordered.map((e) => modelKey(e.model)));
  // several lineages: family = lineage (the strongest independence); one lineage: family = the model itself
  const family = (e: Omit<PoolEntry, "family">) =>
    lineages.length >= 2 ? famOf(e) : `model:${modelKey(e.model)}`;
  const entries: PoolEntry[] = ordered.map((e) => ({ ...e, family: family(e) }));

  const notes: PoolReport["notes"] = [];
  const single = distinctModels.size === 1;
  if (entries.length === 0)
    notes.push({
      level: "block",
      text: "No AI models yet. Add at least two (free keys from Google AI Studio and Groq take two minutes).",
    });
  else if (single && !cfg.prefs.allow_same_model)
    notes.push({
      level: "block",
      text: `Only one model was found across all your endpoints (${entries[0]?.model}). The court needs a second model to argue the other side. Add another model, or accept the same model on both sides.`,
    });
  else if (single)
    notes.push({
      level: "warn",
      text: "One model argues both sides. It works, but the bear tends to agree with the bull, so fewer bad trades get caught. Add a second model when you can.",
    });
  else if (lineages.length === 1)
    notes.push({
      level: "warn",
      text: `All your models are from one family (${lineages[0]}). The court will pair different models, but a bear from another family disagrees more usefully.`,
    });
  else notes.push({ level: "ok", text: `${entries.length} models from ${lineages.length} families.` });

  const families: Record<string, string> = { ...r.families };
  for (const e of entries) families[`${e.provider}/${e.model}`] = e.family;
  let bear = entries.map((e) => ({ provider: e.provider, model: e.model }));
  if (single && cfg.prefs.allow_same_model) {
    // the same model under a second name with its own family, so the cross-family rule lets it argue the bear
    bear = entries.map((e) => {
      const alias = `${e.provider}~bear`;
      providers[alias] = providers[e.provider];
      families[`${alias}/${e.model}`] = `${e.family}~bear`;
      if (caps[e.provider] !== undefined) caps[alias] = caps[e.provider] as number;
      return { provider: alias, model: e.model };
    });
  }
  const chain = entries.map((e) => ({ provider: e.provider, model: e.model }));
  const out: Doctrine =
    entries.length === 0
      ? d
      : {
          ...d,
          llm_routing: {
            ...r,
            families,
            daily_call_caps: caps,
            bull_chain: chain,
            // the bear starts one step further round, so the two sides lead with different models
            bear_chain: bear.length > 1 ? [...bear.slice(1), bear[0] as (typeof bear)[number]] : bear,
            panel: { ...r.panel, chain },
          },
        };
  return {
    providers,
    d: out,
    report: { entries, models: distinctModels.size, lineages, notes },
  };
}

/** A router over the pool with round robin on (or off) per the user's preference. */
export function poolRouter(built: ReturnType<typeof buildPool>, prefs: PoolPrefs): LlmRouter {
  const router = new LlmRouter(built.providers, built.d);
  if (prefs.round_robin && built.report.entries.length > 1) {
    const tier = new Map(
      built.report.entries.map((e) => [`${e.provider.replace(/~bear$/, "")}/${e.model}`, e.tier]),
    );
    router.rotation = {
      chains: new Set([built.d.llm_routing.bull_chain, built.d.llm_routing.bear_chain]),
      tierOf: (h) =>
        prefs.prefer === "mixed"
          ? "all"
          : (tier.get(`${h.provider.replace(/~bear$/, "")}/${h.model}`) ?? "free") === "paid"
            ? "paid"
            : "free",
    };
  }
  return router;
}
