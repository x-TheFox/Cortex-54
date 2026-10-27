import { describe, expect, it } from "vitest";
import { WorkersAiClef } from "../src/clef/ClefClient.ts";
import { CloudflareRestAi, ShimClairic, ShimClef } from "../src/clef/portable.ts";
import { AnthropicProvider } from "../src/court/anthropic.ts";
import type { LlmProvider } from "../src/court/llm.ts";
import { LlmRouter, rotateChain } from "../src/court/llm.ts";
import { lineage, listModels, normalizeUrl, presetForKey } from "../src/court/models.ts";
import { buildPool, endpointProvider, type PoolConfig, parsePool, poolRouter } from "../src/court/pool.ts";
import { buildProviders } from "../src/court/providers.ts";
import { doctrine } from "./helpers.ts";

const ep = (
  id: string,
  models: string[],
  tier: "free" | "paid" | "local" = "paid",
  format: "openai" | "anthropic" = "openai",
) => ({
  id,
  name: id,
  format,
  url: format === "anthropic" ? "https://api.anthropic.com" : `https://${id}.example/v1`,
  key: "k",
  models,
  tier,
  enabled: true,
});
const prefs = (p: Partial<PoolConfig["prefs"]> = {}) => ({
  prefer: "free_first" as const,
  round_robin: true,
  allow_same_model: false,
  demoted: [] as string[],
  ...p,
});

describe("model pool (ADR-072): unlimited endpoints, round robin, fallbacks", () => {
  it("built-in free providers and the user's endpoints form one pool; free first, paid after", () => {
    const empty = buildPool(doctrine, {}, { endpoints: [], prefs: prefs() });
    expect(empty.d).toBe(doctrine);
    expect(empty.report.notes[0]?.level).toBe("block");
    const built = buildPool(doctrine, buildProviders({ GROQ_API_KEY: "gsk" }), {
      endpoints: [ep("claude", ["claude-opus-5-5"], "paid", "anthropic"), ep("box", ["llama-4"], "local")],
      prefs: prefs(),
    });
    const order = built.report.entries.map((e) => `${e.tier}:${e.model}`);
    expect(order.at(-1)).toBe("paid:claude-opus-5-5"); // paid is the fallback when the user prefers free
    expect(order).toContain("local:llama-4");
    expect(built.d.llm_routing.bull_chain.map((h) => h.model)).toEqual(
      built.report.entries.map((e) => e.model),
    );
    // the bear leads with a different model than the bull
    expect(built.d.llm_routing.bear_chain[0]).not.toEqual(built.d.llm_routing.bull_chain[0]);
    // several lineages → family = lineage
    expect(built.report.lineages).toEqual(
      expect.arrayContaining(["anthropic", "meta", "openai-oss", "qwen"]),
    );
    const paidFirst = buildPool(doctrine, buildProviders({ GROQ_API_KEY: "gsk" }), {
      endpoints: [ep("claude", ["claude-opus-5-5"], "paid", "anthropic")],
      prefs: prefs({ prefer: "paid_first" }),
    });
    expect(paidFirst.report.entries[0]?.model).toBe("claude-opus-5-5");
  });

  it("round robin rotates within each tier group; other chains run as given", async () => {
    expect(
      rotateChain(
        [1, 2, 3, 9].map((n) => ({ provider: "p", model: String(n) })),
        1,
        (h) => (h.model === "9" ? "paid" : "free"),
      ).map((h) => h.model),
    ).toEqual(["2", "3", "1", "9"]);
    const calls: string[] = [];
    const fake = (name: string) => ({
      async complete(model: string) {
        calls.push(`${name}/${model}`);
        return { text: '{"ok":1}', inputTokens: 1, outputTokens: 1 };
      },
    });
    const built = buildPool(
      doctrine,
      {},
      { endpoints: [ep("a", ["gpt-x", "claude-y", "gemini-z"], "free")], prefs: prefs() },
    );
    built.providers["ep:a"] = fake("a");
    const router = poolRouter(built, prefs());
    const req = { system: "s", user: "u", maxOutputTokens: 10, schema: {} };
    for (let i = 0; i < 3; i++)
      await router.run(
        built.d.llm_routing.bull_chain,
        req,
        (j) => j,
        [],
        () => undefined,
      );
    expect(calls).toEqual(["a/gpt-x", "a/claude-y", "a/gemini-z"]);
    calls.length = 0;
    await router.run(
      [...built.d.llm_routing.bull_chain],
      req,
      (j) => j,
      [],
      () => undefined,
    ); // a copy: not rotated
    expect(calls).toEqual(["a/gpt-x"]);
    const off = poolRouter(built, prefs({ round_robin: false }));
    calls.length = 0;
    for (let i = 0; i < 2; i++)
      await off.run(
        built.d.llm_routing.bull_chain,
        req,
        (j) => j,
        [],
        () => undefined,
      );
    expect(calls).toEqual(["a/gpt-x", "a/gpt-x"]);
  });

  it("a rate-limited model sits out for a few minutes, then rejoins the rotation", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const prov = {
      async complete(model: string) {
        calls.push(model);
        if (model === "busy") throw new Error("429 rate limited");
        return { text: '{"ok":1}', inputTokens: 1, outputTokens: 1 };
      },
    };
    const built = buildPool(
      doctrine,
      {},
      { endpoints: [ep("a", ["busy", "calm"], "free")], prefs: prefs({ round_robin: false }) },
    );
    built.providers["ep:a"] = prov;
    const router = new LlmRouter(built.providers, built.d, () => now);
    const req = { system: "s", user: "u", maxOutputTokens: 10, schema: {} };
    await router.run(
      built.d.llm_routing.bull_chain,
      req,
      (j) => j,
      [],
      () => undefined,
    );
    expect(calls).toEqual(["busy", "calm"]);
    calls.length = 0;
    await router.run(
      built.d.llm_routing.bull_chain,
      req,
      (j) => j,
      [],
      () => undefined,
    );
    expect(calls).toEqual(["calm"]); // cooling down: tried last, and "calm" answered
    now += router.cooldownMs + 1;
    calls.length = 0;
    await router.run(
      built.d.llm_routing.bull_chain,
      req,
      (j) => j,
      [],
      () => undefined,
    );
    expect(calls).toEqual(["busy", "calm"]);
  });

  it("one lineage: each model is its own family; one model: blocked unless the user accepts it (then warned)", () => {
    const one = buildPool(
      doctrine,
      {},
      { endpoints: [ep("a", ["claude-opus-5-5", "claude-sonnet-5-5"], "paid", "anthropic")], prefs: prefs() },
    );
    expect(one.report.notes[0]?.level).toBe("warn");
    const fam = one.d.llm_routing.families;
    expect(fam["ep:a/claude-opus-5-5"]).not.toBe(fam["ep:a/claude-sonnet-5-5"]);
    // the same model on two endpoints counts once
    const same = {
      endpoints: [ep("a", ["meta-llama/llama-4"]), ep("b", ["llama-4:free"], "free")],
      prefs: prefs(),
    };
    const blocked = buildPool(doctrine, {}, same);
    expect(blocked.report.models).toBe(1);
    expect(blocked.report.notes[0]).toMatchObject({
      level: "block",
      text: expect.stringMatching(/Only one model/),
    });
    const forced = buildPool(doctrine, {}, { ...same, prefs: prefs({ allow_same_model: true }) });
    expect(forced.report.notes[0]).toMatchObject({
      level: "warn",
      text: expect.stringMatching(/both sides/),
    });
    const r = new LlmRouter(forced.providers, forced.d);
    const bear = forced.d.llm_routing.bear_chain[0] as { provider: string; model: string };
    const bull = forced.d.llm_routing.bull_chain[0] as { provider: string; model: string };
    expect(bear.provider).toMatch(/~bear$/);
    expect(r.familyOf(bear.provider, bear.model)).not.toBe(r.familyOf(bull.provider, bull.model));
    expect(forced.providers[bear.provider]).toBe(forced.providers[bear.provider.replace(/~bear$/, "")]);
  });

  it("the cloud pool secret is validated whole (a bad value is ignored, never half-used)", () => {
    expect(parsePool("not json").endpoints).toEqual([]);
    expect(parsePool(JSON.stringify({ endpoints: [{ id: "BAD ID" }] })).endpoints).toEqual([]);
    expect(parsePool(JSON.stringify({ endpoints: [ep("ok", ["m"])] })).endpoints).toHaveLength(1);
    expect(presetForKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")?.id).toBe("anthropic");
    expect(presetForKey("gsk_abcdefghijklmnopqrstuvwxyz")?.builtinKey).toBe("GROQ_API_KEY");
    expect(presetForKey("sk-proj-abcdefghijklmnopqrstuvwxyz")?.id).toBe("openai");
    expect(presetForKey("hello")).toBeNull();
  });

  it("URLs are normalized per format", () => {
    expect(normalizeUrl("anthropic", "https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
    expect(normalizeUrl("anthropic", "")).toBe("https://api.anthropic.com");
    expect(normalizeUrl("openai", "")).toBe("https://api.openai.com/v1");
    expect(normalizeUrl("openai", "http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(lineage("meta-llama/Llama-4-70B")).toBe("meta");
    expect(lineage("gpt-oss-120b")).toBe("openai-oss");
  });

  it("model discovery: OpenAI-style /models (with a /v1 retry) and Anthropic-style Models API; failures are soft", async () => {
    const seen: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push(
        `${url} ${new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-api-key")}`,
      );
      if (url === "http://box:8000/models") return new Response("not found", { status: 404 });
      if (url === "http://box:8000/v1/models")
        return Response.json({ data: [{ id: "qwen3" }, { id: "llama-4" }] });
      if (url.startsWith("https://api.anthropic.com/v1/models"))
        return Response.json({
          data: [
            {
              id: "claude-opus-5-5",
              type: "model",
              display_name: "Opus",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          has_more: false,
          first_id: "claude-opus-5-5",
          last_id: "claude-opus-5-5",
        });
      if (url === "https://bad.example/v1/models") return new Response("nope", { status: 401 });
      return new Response("?", { status: 500 });
    };
    expect(await listModels("openai", "http://box:8000", "k1", fetcher)).toEqual({
      ok: true,
      url: "http://box:8000/v1",
      models: ["llama-4", "qwen3"],
    });
    expect(seen[0]).toBe("http://box:8000/models Bearer k1");
    expect(await listModels("anthropic", "https://api.anthropic.com/v1", "sk-ant", fetcher)).toEqual({
      ok: true,
      url: "https://api.anthropic.com",
      models: ["claude-opus-5-5"],
    });
    expect(seen.at(-1)).toContain("sk-ant");
    const bad = await listModels("openai", "https://bad.example/v1", "x", fetcher);
    expect(bad.ok).toBe(false);
    expect(await listModels("openai", "ftp://x", "x", fetcher)).toMatchObject({ ok: false });
  });

  it("OpenAI-compatible BYOK adapts to a server that rejects temperature / max_tokens / JSON mode", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(b);
      if ("temperature" in b) return new Response("Unsupported value: 'temperature'", { status: 400 });
      if ("max_tokens" in b) return new Response("Unsupported parameter: 'max_tokens'", { status: 400 });
      return Response.json({ choices: [{ message: { content: '{"ok":1}' } }], usage: {} });
    };
    const p = endpointProvider({ ...ep("o", ["gpt-x"]), url: "https://api.openai.com/v1" }, fetcher);
    const out = await p.complete(
      "gpt-x",
      { system: "S", user: "U", maxOutputTokens: 100, schema: {} },
      5_000,
    );
    expect(out.text).toBe('{"ok":1}');
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
    });
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
    const p: LlmProvider = endpointProvider(ep("claude", ["claude-opus-5-5"], "paid", "anthropic"), fetcher);
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
    // a proxy (or a model without server-side fallbacks) never gets the beta: it would 400 there
    const proxy = new AnthropicProvider("k", fetcher, { baseURL: "https://proxy.example", fallbacks: false });
    refuse = false;
    await proxy.complete("some-model", { system: "S", user: "U", maxOutputTokens: 10, schema: {} }, 30_000);
    expect(seen.at(-1)?.url).toBe("https://proxy.example/v1/messages");
    expect(seen.at(-1)?.body.fallbacks).toBeUndefined();
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

  it("Clairic stand-in returns Clairic's shape; unstated values are null, estimates outside the range dropped", async () => {
    let schema: Record<string, unknown> = {};
    const llm: LlmProvider = {
      async complete(_m, req) {
        schema = req.schema;
        return {
          text: JSON.stringify({
            answers: {
              surprise_pct: { value: "12.5", confidence: 0.9 },
              event_date: { value: "next week", confidence: 0.8 },
              move: { value: 400, confidence: 0.5 },
              guidance: { value: null, confidence: 0.7 },
            },
          }),
          inputTokens: 50,
          outputTokens: 10,
        };
      },
    };
    const r = await new ShimClairic(llm, "m").run(
      "ACME beat by 12.5%",
      {
        surprise_pct: { type: "number", instructions: "EPS surprise %" },
        event_date: { type: "date", instructions: "date" },
        move: { type: "estimate", instructions: "1-day move %", min: -50, max: 50, step: 1 },
        guidance: { type: "text", instructions: "guidance" },
      },
      "2026-10-26",
    );
    expect(r.answers.surprise_pct).toEqual({ value: 12.5, confidence: 0.9 });
    expect(r.answers.event_date).toEqual({ value: null, confidence: 0 });
    expect(r.answers.move).toEqual({ value: null, confidence: 0 });
    expect(r.answers.guidance).toEqual({ value: null, confidence: 0 });
    expect(JSON.stringify(schema)).toContain('"required":["surprise_pct","event_date","move","guidance"]');
  });
});
