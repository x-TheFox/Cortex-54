import Anthropic from "@anthropic-ai/sdk";
import type { Fetcher } from "./llm.ts";

/** Endpoint helpers shared by the pool, the settings page and the CLI (ADR-072). */
export type ApiFormat = "openai" | "anthropic";
type ByokFormat = ApiFormat;

export const DEFAULT_URL: Record<ApiFormat, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export function normalizeUrl(format: ByokFormat, url: string | undefined): string {
  const u = (url ?? "").trim().replace(/\/+$/, "") || DEFAULT_URL[format];
  return format === "anthropic" ? u.replace(/\/v1$/, "") : u;
}

/** Rough model lineage from its id (for the "same family" warning; never used to block). */
export function lineage(model: string): string {
  const m = model.toLowerCase().split("/").pop() ?? "";
  const table: [RegExp, string][] = [
    [/claude|opus|sonnet|haiku|fable/, "anthropic"],
    [/^gpt-oss/, "openai-oss"],
    [/^(gpt|o\d|chatgpt)/, "openai"],
    [/gemini|gemma/, "google"],
    [/llama/, "meta"],
    [/qwen|qwq/, "qwen"],
    [/deepseek/, "deepseek"],
    [/mistral|mixtral|codestral|magistral/, "mistral"],
    [/nemotron/, "nvidia"],
    [/grok/, "xai"],
    [/kimi|moonshot/, "moonshot"],
    [/glm|chatglm/, "zhipu"],
    [/phi-?\d/, "microsoft"],
  ];
  return table.find(([re]) => re.test(m))?.[1] ?? m;
}

/**
 * Presets the onboarding wizard offers (ADR-072): where to get a key, the base URL, whether there is a free tier.
 * `keyPattern` lets the app recognize a pasted key and pick the preset by itself.
 */
export interface Preset {
  id: string;
  name: string;
  format: ApiFormat;
  url: string;
  tier: "free" | "paid" | "local";
  keyUrl: string | null;
  keyPattern: string | null;
  note: string;
  /** a built-in provider with verified models and caps: the key is stored under this name instead of an endpoint */
  builtinKey?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "gemini",
    name: "Google Gemini (free)",
    format: "openai",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    tier: "free",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPattern: "^AIza[0-9A-Za-z_-]{30,}$",
    note: "Free daily quota. Sign in with a Google account, press Create API key.",
    builtinKey: "GEMINI_API_KEY",
  },
  {
    id: "groq",
    name: "Groq (free)",
    format: "openai",
    url: "https://api.groq.com/openai/v1",
    tier: "free",
    keyUrl: "https://console.groq.com/keys",
    keyPattern: "^gsk_[0-9A-Za-z]{20,}$",
    note: "Free, very fast. Several model families (OpenAI open models, Qwen, Llama).",
    builtinKey: "GROQ_API_KEY",
  },
  {
    id: "nim",
    name: "NVIDIA NIM (free)",
    format: "openai",
    url: "https://integrate.api.nvidia.com/v1",
    tier: "free",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    keyPattern: "^nvapi-[0-9A-Za-z_-]{20,}$",
    note: "Free credits; adds the Nemotron family.",
    builtinKey: "NVIDIA_API_KEY",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    format: "openai",
    url: "https://openrouter.ai/api/v1",
    tier: "free",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPattern: "^sk-or-[0-9A-Za-z_-]{20,}$",
    note: "One key for hundreds of models; the ones ending in :free cost nothing (tight limits).",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    format: "anthropic",
    url: "https://api.anthropic.com",
    tier: "paid",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPattern: "^sk-ant-[0-9A-Za-z_-]{20,}$",
    note: "Paid. Strong reasoning for the court.",
  },
  {
    id: "openai",
    name: "OpenAI",
    format: "openai",
    url: "https://api.openai.com/v1",
    tier: "paid",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPattern: "^sk-(proj-)?[0-9A-Za-z_-]{20,}$",
    note: "Paid.",
  },
  {
    id: "ollama",
    name: "Ollama (on this computer)",
    format: "openai",
    url: "http://127.0.0.1:11434/v1",
    tier: "local",
    keyUrl: "https://ollama.com/download",
    keyPattern: null,
    note: "Free and private; runs models on your own machine. No key needed.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (on this computer)",
    format: "openai",
    url: "http://127.0.0.1:1234/v1",
    tier: "local",
    keyUrl: "https://lmstudio.ai",
    keyPattern: null,
    note: "Free and private; start its local server first. No key needed.",
  },
  {
    id: "custom",
    name: "Any other endpoint",
    format: "openai",
    url: "",
    tier: "paid",
    keyUrl: null,
    keyPattern: null,
    note: "Any OpenAI- or Anthropic-compatible API (Together, Fireworks, DeepSeek, Mistral, vLLM, a proxy…).",
  },
];

/** Recognize a pasted key (sk-ant-…, gsk_…, AIza…). Order matters: sk-ant- and sk-or- before plain sk-. */
export function presetForKey(key: string): Preset | null {
  const k = key.trim();
  for (const p of PRESETS) if (p.keyPattern && new RegExp(p.keyPattern).test(k)) return p;
  return null;
}

export type ModelList =
  | { ok: true; url: string; models: string[] }
  | { ok: false; url: string; error: string };

/**
 * Discover models at an endpoint: OpenAI-style `GET {url}/models`, Anthropic-style the Models API through the SDK.
 * When an OpenAI-style URL has no version path and `/models` 404s, `{url}/v1/models` is tried and the working URL
 * returned. A failure is not fatal: the settings page then asks for the model name by hand.
 */
export async function listModels(
  format: ApiFormat,
  rawUrl: string | undefined,
  key: string,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<ModelList> {
  const url = normalizeUrl(format, rawUrl);
  if (!/^https?:\/\//.test(url))
    return { ok: false, url, error: "the URL must start with http:// or https://" };
  try {
    if (format === "anthropic") {
      const client = new Anthropic({
        apiKey: key || "none",
        baseURL: url,
        maxRetries: 0,
        timeout: 15_000,
        fetch: fetcher as unknown as typeof fetch,
      });
      const models: string[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        models.push(m.id);
        if (models.length >= 500) break;
      }
      return { ok: true, url, models };
    }
    const tryList = async (
      base: string,
    ): Promise<{ status: number; models: string[] | null; body: string }> => {
      const res = await fetcher(`${base}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (!res.ok) return { status: res.status, models: null, body: text };
      const j = JSON.parse(text) as {
        data?: { id?: unknown }[];
        models?: { name?: unknown; model?: unknown }[];
      };
      const ids = (j.data ?? []).map((x) => x.id).filter((x): x is string => typeof x === "string");
      // Ollama's native /api/tags shape, in case a user points at it
      const tags = (j.models ?? [])
        .map((x) => x.model ?? x.name)
        .filter((x): x is string => typeof x === "string");
      return { status: res.status, models: [...ids, ...tags].slice(0, 500), body: "" };
    };
    let r = await tryList(url);
    let working = url;
    if (!r.models && r.status === 404 && !/\/v\d+$/.test(url)) {
      const alt = await tryList(`${url}/v1`);
      if (alt.models) {
        r = alt;
        working = `${url}/v1`;
      }
    }
    if (!r.models) return { ok: false, url, error: `HTTP ${r.status}: ${r.body.slice(0, 160)}` };
    return { ok: true, url: working, models: [...new Set(r.models)].sort() };
  } catch (e) {
    const msg =
      e instanceof Anthropic.AuthenticationError
        ? "the key was rejected (401)"
        : e instanceof Anthropic.NotFoundError
          ? "this endpoint has no model listing (404)"
          : e instanceof Anthropic.APIError
            ? `HTTP ${e.status ?? "?"}: ${e.message.slice(0, 160)}`
            : String(e).slice(0, 200);
    return { ok: false, url, error: msg };
  }
}
