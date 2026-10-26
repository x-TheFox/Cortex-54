import { describe, expect, it } from "vitest";
import { WorkersAiClef } from "../src/clef/ClefClient.ts";
import { CloudflareRestAi, ShimClef } from "../src/clef/portable.ts";
import { AnthropicProvider } from "../src/court/anthropic.ts";
import type { LlmProvider } from "../src/court/llm.ts";
import { LlmRouter } from "../src/court/llm.ts";
import { buildProviders, withByok } from "../src/court/providers.ts";
import { doctrine } from "./helpers.ts";

describe("BYOK court providers (ADR-063)", () => {
  it("frontier hops lead only for providers with a key; free chains stay behind them", () => {
    const none = withByok(doctrine, buildProviders({}), {});
    expect(none).toBe(doctrine);
    const keys = { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "gpt-x" };
    const d = withByok(doctrine, buildProviders(keys), keys);
    expect(d.llm_routing.bull_chain.slice(0, 2)).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
      { provider: "openai", model: "gpt-x" },
    ]);
    expect(d.llm_routing.bear_chain[0]).toEqual({ provider: "openai", model: "gpt-x" });
    expect(d.llm_routing.bull_chain.at(-1)).toEqual(doctrine.llm_routing.bull_chain.at(-1));
    // an Ollama base URL without a model name adds nothing (the model is the user's choice)
    const o = { OLLAMA_BASE_URL: "http://localhost:11434/v1" };
    expect(withByok(doctrine, buildProviders(o), o)).toBe(doctrine);
    const o2 = { ...o, OLLAMA_MODEL: "qwen3:14b" };
    expect(withByok(doctrine, buildProviders(o2), o2).llm_routing.bull_chain[0]).toEqual({
      provider: "ollama",
      model: "qwen3:14b",
    });
  });

  it("Claude bull and OpenAI bear form a cross-family pair", () => {
    const r = new LlmRouter({}, doctrine);
    expect(r.familyOf("anthropic", "claude-opus-5-5")).toBe("anthropic");
    expect(r.familyOf("openai", "gpt-x")).toBe("openai");
  });

  it("Anthropic provider: model, refusal fallback beta, JSON-only instruction, refusals become provider errors", async () => {
    const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    let refuse = false;
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: refuse ? [] : [{ type: "text", text: '{"thesis":"ok"}' }],
        stop_reason: refuse ? "refusal" : "end_turn",
        stop_details: refuse ? { type: "refusal", category: "cyber", explanation: null } : null,
        usage: { input_tokens: 12, output_tokens: 5 },
      });
    };
    const p: LlmProvider = new AnthropicProvider("sk-ant-test", fetcher);
    const out = await p.complete(
      "claude-opus-5-5",
      { system: "S", user: "U", maxOutputTokens: 1500, schema: { type: "object" } },
      30_000,
    );
    expect(out).toEqual({ text: '{"thesis":"ok"}', inputTokens: 12, outputTokens: 5 });
    expect(seen[0]?.url).toContain("/v1/messages");
    expect(seen[0]?.body.model).toBe("claude-opus-5-5");
    expect(seen[0]?.body.fallbacks).toBe("default");
    expect(seen[0]?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(Number(seen[0]?.body.max_tokens)).toBeGreaterThanOrEqual(16_000);
    refuse = true;
    await expect(
      p.complete("claude-opus-5-5", { system: "S", user: "U", maxOutputTokens: 10, schema: {} }, 30_000),
    ).rejects.toThrow(/refused \(cyber\)/);
  });
});

describe("portable Clef (ADR-063)", () => {
  it("REST binding: account URL, bearer token, unwraps result; errors fail", async () => {
    const calls: string[] = [];
    const ai = new CloudflareRestAi("acct123", "tok", async (url, init) => {
      calls.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      return Response.json({
        success: true,
        result: { model: "clef", answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 9 } },
      });
    });
    const r = await new WorkersAiClef(ai).run("clef", { x: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(r.answers.q).toEqual({ type: "noul", noul: 0.7 });
    expect(calls[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef Bearer tok",
    );
    const bad = new CloudflareRestAi("a", "t", async () =>
      Response.json({ success: false, errors: [{ message: "no" }] }, { status: 403 }),
    );
    await expect(bad.run("m", {})).rejects.toThrow(/workers-ai 403/);
  });

  it("shim answers Clef's question format with any chat model; bad answers are dropped (fail closed)", async () => {
    let prompt = "";
    const llm: LlmProvider = {
      async complete(_m, req) {
        prompt = req.user;
        return {
          text: JSON.stringify({
            answers: {
              long: { type: "noul", noul: 1.4 },
              setup: { choice: "breakout", probabilities: { breakout: 0.7, no_trade: 0.3 } },
              quality: { score: 3.2 },
              bogus_choice: { choice: "made_up" },
            },
          }),
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    };
    const r = await new ShimClef(llm, "qwen3").run(
      "clef",
      { evidence: 1 },
      {
        long: { type: "noul", instructions: "Long favored?" },
        setup: { type: "choice", instructions: "Setup?", criteria: { breakout: "b", no_trade: "n" } },
        quality: { type: "score", instructions: "Quality", criteria: ["P", "W", "F", "S", "E"] },
        bogus_choice: { type: "choice", instructions: "x", criteria: { a: "a" } },
        missing: { type: "noul", instructions: "never answered" },
      },
    );
    expect(r.answers.long).toEqual({ type: "noul", noul: 1 });
    expect(r.answers.setup).toMatchObject({ type: "choice", choice: "breakout" });
    expect(r.answers.quality).toEqual({ type: "score", score: 3 });
    expect(r.answers.bogus_choice).toBeUndefined();
    expect(r.answers.missing).toBeUndefined();
    expect(prompt).toContain('"setup" (choice)');
  });
});
