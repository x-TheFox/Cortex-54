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

interface CallShape {
  json: boolean;
  temperature: boolean;
  completionTokens: boolean;
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
      /**
       * BYOK endpoints are unknown servers: on a 400 that names a parameter they reject (response_format, temperature,
       * max_tokens → max_completion_tokens), drop or rename it and retry, up to three times.
       */
      adaptive?: boolean;
    } = { jsonMode: true },
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async complete(model: string, req: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    const shape: CallShape = { json: this.opts.jsonMode, temperature: true, completionTokens: false };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call(model, req, timeoutMs, shape);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.status !== 400) throw e;
        const msg = e.message;
        // ADR-070 (canary 2026-10-26): Groq's JSON mode rejects some models' valid-looking replies with a 400
        // ("Failed to validate JSON"). One retry without JSON mode; the court's own parser and schema decide.
        if (shape.json && /validate JSON|json_validate/i.test(msg)) {
          shape.json = false;
          continue;
        }
        if (!this.opts.adaptive || attempt >= 3) throw e;
        if (shape.json && /response_format|json_object|json mode/i.test(msg)) shape.json = false;
        else if (shape.temperature && /temperature/i.test(msg)) shape.temperature = false;
        else if (!shape.completionTokens && /max_tokens|max_completion_tokens/i.test(msg))
          shape.completionTokens = true;
        else throw e;
      }
    }
  }

  private async call(
    model: string,
    req: LlmRequest,
    timeoutMs: number,
    shape: CallShape,
  ): Promise<LlmResponse> {
    const maxOut = Math.max(req.maxOutputTokens, this.opts.minOutputTokens ?? 0);
    const d = (await post(
      this.fetcher,
      this.name,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.key}` },
      {
        model,
        ...(shape.temperature ? { temperature: 0.2 } : {}),
        ...(shape.completionTokens ? { max_completion_tokens: maxOut } : { max_tokens: maxOut }),
        messages: [
          {
            role: "system",
            content: `${req.system}\n\nRespond with ONE JSON object matching this schema:\n${JSON.stringify(req.schema)}`,
          },
          { role: "user", content: req.user },
        ],
        ...(shape.json ? { response_format: { type: "json_object" } } : {}),
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
/** Rotate each run of same-tier hops by `n`, keeping the tier order. Pure. */
export function rotateChain<T extends { provider: string; model: string }>(
  chain: readonly T[],
  n: number,
  tierOf: (h: T) => string,
): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < chain.length) {
    let j = i;
    const t = tierOf(chain[i] as T);
    while (j < chain.length && tierOf(chain[j] as T) === t) j++;
    const group = chain.slice(i, j);
    const k = group.length ? n % group.length : 0;
    out.push(...group.slice(k), ...group.slice(0, k));
    i = j;
  }
  return out;
}

export class LlmRouter {
  /** Audit W2-06: optional per-provider quota gate (the brain plugs in its daily counters). */
  gate: {
    allow(provider: string): boolean;
    used(provider: string): void;
    /** ADR-075: tokens a provider used (the brain keeps a per-day count, so the spend cap survives restarts) */
    tokens?(provider: string, input: number, output: number): void;
    tokensToday?(provider: string): { input: number; output: number };
  } | null = null;
  /** ADR-075 cost meter: USD per 1M tokens per provider, with an optional daily spend cap */
  pricing: Record<string, { in: number; out: number; cap?: number }> = {};

  /** USD a provider has spent today (0 when it has no price). */
  spentToday(provider: string): number {
    const p = this.pricing[provider];
    const t = this.gate?.tokensToday?.(provider);
    return p && t ? (t.input * p.in + t.output * p.out) / 1_000_000 : 0;
  }

  private overBudget(provider: string): boolean {
    const cap = this.pricing[provider]?.cap;
    return cap !== undefined && this.spentToday(provider) >= cap;
  }
  /**
   * ADR-072 round robin: these chains (by identity: the pool's bull and bear chains) start one model further round
   * on every use, within each tier group, so free-tier quotas are shared across the whole pool. Other chains (the
   * rebuttal pinned to the bull's own model, the panel's per-seat rotations) run as given.
   */
  rotation: {
    chains: Set<readonly unknown[]>;
    tierOf: (h: { provider: string; model: string }) => string;
  } | null = null;
  private readonly turns = new Map<readonly unknown[], number>();
  /**
   * ADR-072: a model that was rate-limited or timed out sits out for a few minutes, so the rotation stops landing on
   * a free tier that is already exhausted (it is still tried if nothing else is left).
   */
  readonly cooldownMs = 5 * 60_000;
  private readonly cooling = new Map<string, number>();

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
    if (this.rotation?.chains.has(chain)) {
      const n = this.turns.get(chain) ?? 0;
      this.turns.set(chain, n + 1);
      chain = rotateChain(chain, n, this.rotation.tierOf);
    }
    const t = this.now();
    const hot = (h: { provider: string; model: string }) =>
      (this.cooling.get(`${h.provider}/${h.model}`) ?? 0) > t;
    chain = [...chain.filter((h) => !hot(h)), ...chain.filter(hot)];
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
      if (!p || (this.gate && !this.gate.allow(hop.provider)) || this.overBudget(hop.provider)) {
        log({ ...base, latencyMs: 0, outcome: "UNAVAILABLE" });
        continue;
      }
      for (let attempt = 0; attempt <= r.max_retries_per_provider; attempt++) {
        const t0 = this.now();
        this.gate?.used(hop.provider);
        try {
          const res = await p.complete(hop.model, req, timeoutMs ?? r.timeout_ms);
          // a provider that doesn't report usage is estimated at ~4 characters per token (prompt only)
          this.gate?.tokens?.(
            hop.provider,
            res.inputTokens ?? Math.ceil((req.system.length + req.user.length) / 4),
            res.outputTokens ?? Math.ceil(res.text.length / 4),
          );
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
          if (outcome !== "ERROR") {
            this.cooling.set(`${hop.provider}/${hop.model}`, this.now() + this.cooldownMs);
            break; // rate limits / timeouts: don't hammer, go to the next hop
          }
        }
      }
    }
    return null;
  }
}
