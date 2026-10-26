import type { Doctrine } from "../contracts/doctrine.ts";

/**
 * Free-tier LLM providers for the court (verified live 2026-10-22):
 *  - gemini:  Interactions API (POST /v1beta/interactions); older generateContent 404s for current models.
 *  - groq, nim, openrouter: OpenAI-compatible /chat/completions.
 * Every hop is logged by the caller; a failure moves to the next hop in the doctrine chain.
 */
export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** JSON schema for providers that support it (Gemini); others get JSON mode + the schema in the prompt. */
  schema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmProvider {
  complete(model: string, req: LlmRequest, timeoutMs: number): Promise<LlmResponse>;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} ${status}: ${message.slice(0, 200)}`);
  }
}

async function post(
  fetcher: Fetcher,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
) {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(provider, res.status, text);
  return JSON.parse(text) as unknown;
}

export class GeminiProvider implements LlmProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async complete(model: string, req: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    const d = (await post(
      this.fetcher,
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      { "x-goog-api-key": this.key },
      {
        model,
        system_instruction: req.system,
        input: req.user,
        response_format: { type: "text", mime_type: "application/json", schema: req.schema },
      },
      timeoutMs,
    )) as {
      status?: string;
      steps?: { type?: string; content?: { text?: string }[] }[];
      usage?: { total_input_tokens?: number; total_output_tokens?: number };
    };
    const text = (d.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => (s.content ?? []).map((c) => c.text ?? ""))
      .join("");
    if (!text) throw new ProviderError("gemini", 200, `empty output (status ${d.status ?? "?"})`);
    return {
      text,
      inputTokens: d.usage?.total_input_tokens ?? null,
      outputTokens: d.usage?.total_output_tokens ?? null,
    };
  }
}

export class OpenAICompatProvider implements LlmProvider {
  constructor(
    private readonly name: string,
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly opts: {
      jsonMode: boolean;
      reasoningEffort?: "low" | "medium";
      /** reasoning models spend output tokens thinking before the JSON (canary 2026-10-26: Nemotron cut off at 1,500) */
      minOutputTokens?: number;
    } = { jsonMode: true },
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async complete(model: string, req: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    try {
      return await this.call(model, req, timeoutMs, this.opts.jsonMode);
    } catch (e) {
      // ADR-070 (canary 2026-10-26): Groq's JSON mode rejects some models' valid-looking replies with a 400
      // ("Failed to validate JSON"). One retry without JSON mode; the court's own parser and schema decide.
      if (
        this.opts.jsonMode &&
        e instanceof ProviderError &&
        e.status === 400 &&
        /validate JSON|json_validate/i.test(e.message)
      )
        return this.call(model, req, timeoutMs, false);
      throw e;
    }
  }

  private async call(
    model: string,
    req: LlmRequest,
    timeoutMs: number,
    jsonMode: boolean,
  ): Promise<LlmResponse> {
    const d = (await post(
      this.fetcher,
      this.name,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.key}` },
      {
        model,
        temperature: 0.2,
        max_tokens: Math.max(req.maxOutputTokens, this.opts.minOutputTokens ?? 0),
        messages: [
          {
            role: "system",
            content: `${req.system}\n\nRespond with ONE JSON object matching this schema:\n${JSON.stringify(req.schema)}`,
          },
          { role: "user", content: req.user },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
      },
      timeoutMs,
    )) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = d.choices?.[0]?.message?.content ?? "";
    if (!text) throw new ProviderError(this.name, 200, "empty output");
    return {
      text,
      inputTokens: d.usage?.prompt_tokens ?? null,
      outputTokens: d.usage?.completion_tokens ?? null,
    };
  }
}

/** Pull the first JSON object out of model text (handles ```json fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] ?? "") : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

export interface HopAttempt {
  provider: string;
  model: string;
  family: string;
  latencyMs: number;
  outcome: "OK" | "SCHEMA_FAIL" | "RATE_LIMITED" | "TIMEOUT" | "ERROR" | "UNAVAILABLE" | "SKIPPED_FAMILY";
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
}

export interface ChainResult<T> {
  value: T;
  provider: string;
  model: string;
  family: string;
}

/**
 * Try each hop of a doctrine chain until one returns output that `parse` accepts. Hops whose family is excluded
 * (cross-family rule) or whose provider has no key are skipped. Returns null if every hop fails.
 */
export class LlmRouter {
  /** Audit W2-06: optional per-provider quota gate (the brain plugs in its daily counters). */
  gate: { allow(provider: string): boolean; used(provider: string): void } | null = null;

  constructor(
    private readonly providers: Partial<Record<string, LlmProvider>>,
    private readonly d: Doctrine,
    private readonly now: () => number = () => Date.now(),
  ) {}

  familyOf(provider: string, model: string): string {
    const f = this.d.llm_routing.families;
    return f[`${provider}/${model}`] ?? f[provider] ?? "unknown";
  }

  async run<T>(
    chain: { provider: string; model: string }[],
    req: LlmRequest,
    parse: (json: unknown) => T,
    excludeFamilies: string[],
    log: (a: HopAttempt) => void,
    timeoutMs?: number,
  ): Promise<ChainResult<T> | null> {
    const r = this.d.llm_routing;
    for (const hop of chain) {
      const family = this.familyOf(hop.provider, hop.model);
      const base = {
        provider: hop.provider,
        model: hop.model,
        family,
        inputTokens: null,
        outputTokens: null,
      };
      if (excludeFamilies.includes(family)) {
        log({ ...base, latencyMs: 0, outcome: "SKIPPED_FAMILY" });
        continue;
      }
      const p = this.providers[hop.provider];
      if (!p || (this.gate && !this.gate.allow(hop.provider))) {
        log({ ...base, latencyMs: 0, outcome: "UNAVAILABLE" });
        continue;
      }
      for (let attempt = 0; attempt <= r.max_retries_per_provider; attempt++) {
        const t0 = this.now();
        this.gate?.used(hop.provider);
        try {
          const res = await p.complete(hop.model, req, timeoutMs ?? r.timeout_ms);
          let value: T;
          try {
            value = parse(extractJson(res.text));
          } catch (e) {
            log({
              ...base,
              latencyMs: this.now() - t0,
              outcome: "SCHEMA_FAIL",
              inputTokens: res.inputTokens,
              outputTokens: res.outputTokens,
              error: String(e).slice(0, 200),
            });
            continue; // one more try on the same provider, then move on
          }
          log({
            ...base,
            latencyMs: this.now() - t0,
            outcome: "OK",
            inputTokens: res.inputTokens,
            outputTokens: res.outputTokens,
          });
          return { value, provider: hop.provider, model: hop.model, family };
        } catch (e) {
          const msg = String(e);
          const outcome = /429|rate|quota|503|demand/i.test(msg)
            ? "RATE_LIMITED"
            : /timeout|abort/i.test(msg)
              ? "TIMEOUT"
              : "ERROR";
          log({ ...base, latencyMs: this.now() - t0, outcome, error: msg.slice(0, 200) });
          if (outcome !== "ERROR") break; // rate limits / timeouts: don't hammer, go to the next hop
        }
      }
    }
    return null;
  }
}
