import { pooled, splitKeys } from "./keypool.ts";
import { type Fetcher, GeminiProvider, type LlmProvider, OpenAICompatProvider } from "./llm.ts";

export { DEFAULT_URL, lineage, listModels, normalizeUrl, PRESETS, presetForKey } from "./models.ts";
export { buildPool, type PoolConfig, parsePool } from "./pool.ts";

/**
 * Built-in court providers from keys (shared by the cloud worker and local mode, so a key works the same everywhere).
 * Their verified models, families and daily caps live in the doctrine's chains. The user's own endpoints (any number,
 * OpenAI- or Anthropic-compatible, free or paid) are added on top by `buildPool` (ADR-072).
 */
export interface ProviderKeys {
  GEMINI_API_KEY?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  NVIDIA_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
}

export function buildProviders(k: ProviderKeys, fetcher?: Fetcher): Partial<Record<string, LlmProvider>> {
  const p: Partial<Record<string, LlmProvider>> = {};
  const f = fetcher ?? ((u: string, i?: RequestInit) => fetch(u, i));
  // ADR-097: each key field may hold several keys; they become the provider's inner round-robin pool
  const add = (name: string, raw: string | undefined, make: (key: string) => LlmProvider) => {
    const one = pooled(name, splitKeys(raw), make);
    if (one) p[name] = one;
  };
  add("gemini", k.GEMINI_API_KEY, (key) => new GeminiProvider(key, f));
  add(
    "groq",
    k.GROQ_API_KEY,
    (key) =>
      new OpenAICompatProvider(
        "groq",
        "https://api.groq.com/openai/v1",
        key,
        { jsonMode: true, reasoningEffort: "low" },
        f,
      ),
  );
  add(
    "nim",
    k.NVIDIA_API_KEY,
    (key) =>
      new OpenAICompatProvider(
        "nim",
        "https://integrate.api.nvidia.com/v1",
        key,
        { jsonMode: false, minOutputTokens: 4096 },
        f,
      ),
  );
  add(
    "openrouter",
    k.OPENROUTER_API_KEY,
    (key) =>
      new OpenAICompatProvider("openrouter", "https://openrouter.ai/api/v1", key, { jsonMode: true }, f),
  );
  return p;
}
