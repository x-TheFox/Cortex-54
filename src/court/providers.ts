import type { Doctrine } from "../contracts/doctrine.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { type Fetcher, GeminiProvider, type LlmProvider, OpenAICompatProvider } from "./llm.ts";

/**
 * Court providers from keys (ADR-063). Shared by the cloud worker and local mode, so a key works the same everywhere.
 * Free providers (Gemini, Groq, NIM, OpenRouter) as before; BYOK frontier providers (Anthropic, OpenAI), a local
 * Ollama, and one generic OpenAI-compatible endpoint (Together, Fireworks, LM Studio, vLLM, a paid OpenRouter key…).
 */
export interface ProviderKeys {
  GEMINI_API_KEY?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  NVIDIA_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  /** e.g. http://localhost:11434/v1 */
  OLLAMA_BASE_URL?: string | undefined;
  OLLAMA_MODEL?: string | undefined;
  CUSTOM_LLM_BASE_URL?: string | undefined;
  CUSTOM_LLM_API_KEY?: string | undefined;
  CUSTOM_LLM_MODEL?: string | undefined;
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
      {
        jsonMode: true,
        reasoningEffort: "low",
      },
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
  if (k.ANTHROPIC_API_KEY) p.anthropic = new AnthropicProvider(k.ANTHROPIC_API_KEY, fetcher);
  if (k.OPENAI_API_KEY)
    p.openai = new OpenAICompatProvider(
      "openai",
      "https://api.openai.com/v1",
      k.OPENAI_API_KEY,
      { jsonMode: true },
      f,
    );
  if (k.OLLAMA_BASE_URL && /^https?:\/\//.test(k.OLLAMA_BASE_URL))
    p.ollama = new OpenAICompatProvider(
      "ollama",
      k.OLLAMA_BASE_URL.replace(/\/$/, ""),
      "ollama",
      { jsonMode: true },
      f,
    );
  if (k.CUSTOM_LLM_BASE_URL && /^https?:\/\//.test(k.CUSTOM_LLM_BASE_URL))
    p.custom = new OpenAICompatProvider(
      "custom",
      k.CUSTOM_LLM_BASE_URL.replace(/\/$/, ""),
      k.CUSTOM_LLM_API_KEY ?? "none",
      { jsonMode: true },
      f,
    );
  return p;
}

/** "default" models are filled from the keys (Ollama/custom/OpenAI model names belong to the user). */
function resolveModel(provider: string, model: string, k: ProviderKeys): string | null {
  if (provider === "openai") return k.OPENAI_MODEL || model;
  if (model !== "default") return model;
  if (provider === "ollama") return k.OLLAMA_MODEL || null;
  if (provider === "custom") return k.CUSTOM_LLM_MODEL || null;
  return null;
}

/** The doctrine with BYOK hops (for providers that have a key) in front of the free chains. Pure. */
export function withByok(
  d: Doctrine,
  available: Partial<Record<string, unknown>>,
  k: ProviderKeys,
): Doctrine {
  const r = d.llm_routing;
  const front = (hops: { provider: string; model: string }[]) =>
    hops.flatMap((h) => {
      if (!available[h.provider]) return [];
      const model = resolveModel(h.provider, h.model, k);
      return model ? [{ provider: h.provider, model }] : [];
    });
  const bull = front(r.byok.bull);
  const bear = front(r.byok.bear);
  const panel = front(r.byok.panel);
  if (!bull.length && !bear.length && !panel.length) return d;
  return {
    ...d,
    llm_routing: {
      ...r,
      bull_chain: [...bull, ...r.bull_chain],
      bear_chain: [...bear, ...r.bear_chain],
      panel: { ...r.panel, chain: [...panel, ...r.panel.chain] },
    },
  };
}
