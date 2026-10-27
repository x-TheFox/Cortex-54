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
  if (k.GEMINI_API_KEY) p.gemini = new GeminiProvider(k.GEMINI_API_KEY, f);
  if (k.GROQ_API_KEY)
    p.groq = new OpenAICompatProvider(
      "groq",
      "https://api.groq.com/openai/v1",
      k.GROQ_API_KEY,
      { jsonMode: true, reasoningEffort: "low" },
      f,
    );
  if (k.NVIDIA_API_KEY)
    p.nim = new OpenAICompatProvider(
      "nim",
      "https://integrate.api.nvidia.com/v1",
      k.NVIDIA_API_KEY,
      { jsonMode: false, minOutputTokens: 4096 },
      f,
    );
  if (k.OPENROUTER_API_KEY)
    p.openrouter = new OpenAICompatProvider(
      "openrouter",
      "https://openrouter.ai/api/v1",
      k.OPENROUTER_API_KEY,
      { jsonMode: true },
      f,
    );
  return p;
}
