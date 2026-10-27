import Anthropic from "@anthropic-ai/sdk";
import { type Fetcher, type LlmProvider, type LlmRequest, type LlmResponse, ProviderError } from "./llm.ts";

/**
 * An Anthropic-compatible BYOK endpoint for the court (ADR-063): Anthropic's own API or any service that speaks the
 * Messages API. Uses the official SDK with the host's fetch injected (Workers, Node, tests). Thinking is left at the
 * model's default, so `max_tokens` is generous: thinking tokens count against it. Server-side refusal fallback
 * (`fallbacks: "default"`) is sent only where it exists (api.anthropic.com, supported models); the caller decides.
 * A final refusal is a provider error, so the court moves to the next hop.
 */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly name: string;

  constructor(
    apiKey: string,
    fetcher?: Fetcher,
    private readonly opts: {
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      fallbacks?: boolean;
      baseURL?: string;
      name?: string;
    } = {},
  ) {
    this.name = opts.name ?? "anthropic";
    this.client = new Anthropic({
      apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: 0, // the court router owns retries and failover
      ...(fetcher ? { fetch: fetcher as unknown as typeof fetch } : {}),
    });
  }

  async complete(model: string, req: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    const fallbacks = this.opts.fallbacks ?? false;
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model,
          max_tokens: Math.max(16_000, req.maxOutputTokens),
          system: `${req.system}\n\nRespond with ONE JSON object matching this schema, and nothing else:\n${JSON.stringify(req.schema)}`,
          messages: [{ role: "user", content: req.user }],
          ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
          ...(fallbacks ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: "default" as const } : {}),
        },
        { timeout: timeoutMs },
      );
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError(this.name, 429, "rate limited");
      if (e instanceof Anthropic.APIConnectionTimeoutError)
        throw new ProviderError(this.name, 408, "timeout");
      if (e instanceof Anthropic.APIError) throw new ProviderError(this.name, e.status ?? 0, e.message);
      throw e;
    }
    if (res.stop_reason === "refusal")
      throw new ProviderError(this.name, 200, `refused (${res.stop_details?.category ?? "unspecified"})`);
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) throw new ProviderError(this.name, 200, `empty output (stop ${res.stop_reason ?? "?"})`);
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}
