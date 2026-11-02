import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogPage } from "../local/catalog.ts";
import { loadConfig, newConfig, saveConfig } from "../local/config.ts";
import { LocalSettings } from "../local/settings.ts";
import {
  type Bench,
  benchTargets,
  type Catalog,
  catalogChanged,
  healChains,
  ingestCatalog,
  runBenchmark,
} from "../src/court/catalog.ts";
import type { LlmProvider } from "../src/court/llm.ts";
import { buildPool, modelAllowed } from "../src/court/pool.ts";
import { buildProviders } from "../src/court/providers.ts";
import { doctrine } from "./helpers.ts";

const prefs = (p: Record<string, unknown> = {}) =>
  ({ prefer: "free_first", round_robin: true, allow_same_model: false, demoted: [], ...p }) as never;

describe("model catalog (ADR-099)", () => {
  it("ingests lists, drops non-chat models, and records what was added and removed", async () => {
    const one = await ingestCatalog(
      [
        {
          provider: "groq",
          list: async () => ({
            ok: true,
            models: ["a", "b", "whisper-large", "text-embed-3"],
            free: ["a", "b"],
          }),
        },
      ],
      null,
      1,
    );
    expect(one.providers.groq).toMatchObject({
      ok: true,
      models: ["a", "b"],
      free: ["a", "b"],
      added: [],
      removed: [],
    });
    const two = await ingestCatalog(
      [
        { provider: "groq", list: async () => ({ ok: true, models: ["b", "c"] }) },
        { provider: "nim", list: async () => ({ ok: false, error: "HTTP 503" }) },
      ],
      one,
      2,
    );
    expect(two.providers.groq).toMatchObject({ added: ["c"], removed: ["a"] });
    expect(two.providers.nim?.ok).toBe(false);
    expect(catalogChanged(two)).toBe(true);
  });

  it("benchmarks with four standard tests and scores 0–100", async () => {
    const good: LlmProvider = {
      async complete(_m, req) {
        const s = req.system;
        const text = s.includes("open session")
          ? '{"action":"tools","tool_calls":[{"tool":"calc","input":"(281.95-250.40)/(250.40-241.10)"}]}'
          : s.includes("check a trading court's arithmetic")
            ? '{"reward_to_risk": 2.2, "fee_hurdle_pct": 1.5}'
            : '{"no_trade":true,"thesis":"no clean long","setup":"no_trade","entry_low":0,"entry_high":0,"stop":0,"targets":[],"horizon_hours":24,"conviction":1,"receipts":[]}';
        return { text, inputTokens: 1, outputTokens: 1 };
      },
    };
    const bad: LlmProvider = {
      async complete() {
        return { text: "I think you should buy.", inputTokens: 1, outputTokens: 1 };
      },
    };
    let t = 0;
    const b = await runBenchmark(
      { g: good, x: bad },
      [
        { provider: "g", model: "m1" },
        { provider: "x", model: "m2" },
      ],
      1,
      null,
      () => (t += 10),
    );
    expect(b.results.find((r) => r.model === "m1")?.cases.filter((c) => !c.ok)).toEqual([]);
    expect(b.results.find((r) => r.model === "m1")?.score).toBe(100);
    expect(b.results.find((r) => r.model === "m2")?.score).toBe(0);
    expect(b.strikes["x/m2"]).toBe(1);
  });

  it("heals the chains: a removed model is replaced by its provider's best, degraded ones go last", () => {
    const d = {
      ...doctrine,
      llm_routing: {
        ...doctrine.llm_routing,
        bull_chain: [
          { provider: "groq", model: "old" },
          { provider: "groq", model: "slow" },
          { provider: "gemini", model: "g1" },
        ],
      },
    };
    const cat: Catalog = {
      at: 1,
      providers: {
        groq: {
          ok: true,
          models: ["slow", "new-good", "new-ok"],
          added: ["new-good", "new-ok"],
          removed: ["old"],
        },
        gemini: { ok: false, models: [], added: [], removed: [] }, // unreadable: left alone
      },
    };
    const bench: Bench = {
      at: 1,
      strikes: {},
      results: [
        { provider: "groq", model: "new-good", at: 1, score: 95, cases: [] },
        { provider: "groq", model: "new-ok", at: 1, score: 70, cases: [] },
        { provider: "groq", model: "slow", at: 1, score: 20, cases: [] },
        { provider: "gemini", model: "g1", at: 1, score: 80, cases: [] },
      ],
    };
    const h = healChains(d, cat, bench);
    expect(h.d.llm_routing.bull_chain.map((x) => x.model)).toEqual(["new-good", "g1", "slow"]);
    expect(h.report.replaced).toContainEqual({
      from: "groq/old",
      to: "groq/new-good",
      why: "no longer offered by the provider",
    });
    expect(h.report.demoted).toContain("groq/slow");
    expect(benchTargets(d, cat).map((x) => `${x.provider}/${x.model}`)).toContain("groq/new-ok");
  });
});

describe("which models are allowed (ADR-099)", () => {
  const cat = {
    providers: {
      openrouter: {
        ok: true,
        models: ["meta/llama-4:free", "openai/gpt-5", "qwen/qwen-3:free", "anthropic/claude-x"],
        free: ["meta/llama-4:free", "qwen/qwen-3:free"],
      },
    },
  };
  const or = buildProviders({ OPENROUTER_API_KEY: "or-key", GROQ_API_KEY: "gsk" });

  it("free only keeps paid models and paid endpoints out", () => {
    const p = prefs({ cost_scope: "free_only", models: { openrouter: { mode: "all", picked: [] } } });
    const b = buildPool(
      doctrine,
      or,
      {
        endpoints: [
          {
            id: "c",
            name: "Claude",
            format: "anthropic",
            url: "https://api.anthropic.com",
            key: "k",
            models: ["claude-x"],
            tier: "paid",
            enabled: true,
          },
        ],
        prefs: p,
      },
      undefined,
      cat,
    );
    const models = b.report.entries.map((e) => `${e.provider}/${e.model}`);
    expect(models).toContain("openrouter/meta/llama-4:free");
    expect(models).not.toContain("openrouter/openai/gpt-5");
    expect(models.some((m) => m.startsWith("ep:c"))).toBe(false);
    expect(modelAllowed(p, "openrouter", "openai/gpt-5", false)).toBe(false);
  });

  it("everything adds paid catalog models as paid entries; pick mode uses only the picked ones", () => {
    const all = buildPool(
      doctrine,
      or,
      {
        endpoints: [],
        prefs: prefs({ cost_scope: "all", models: { openrouter: { mode: "all", picked: [] } } }),
      },
      undefined,
      cat,
    );
    expect(all.report.entries.find((e) => e.model === "openai/gpt-5")?.tier).toBe("paid");
    expect(all.d.llm_routing.daily_call_caps.openrouter).toBeUndefined(); // free-tier cap lifted once paid is allowed
    const pick = buildPool(
      doctrine,
      or,
      {
        endpoints: [],
        prefs: prefs({
          models: {
            openrouter: { mode: "pick", picked: ["qwen/qwen-3:free"] },
            groq: { mode: "pick", picked: [] },
          },
        }),
      },
      undefined,
      cat,
    );
    const ids = pick.report.entries.map((e) => `${e.provider}/${e.model}`);
    expect(ids).toContain("openrouter/qwen/qwen-3:free");
    expect(ids.some((m) => m.startsWith("groq/"))).toBe(false);
  });

  it("pages through a long catalog with search and a free filter, picked first", () => {
    const models = Array.from(
      { length: 230 },
      (_, i) => `vendor/model-${String(i).padStart(3, "0")}${i % 3 === 0 ? ":free" : ""}`,
    );
    const c: Catalog = {
      at: 5,
      providers: {
        openrouter: {
          ok: true,
          models,
          free: models.filter((m) => m.endsWith(":free")),
          added: [],
          removed: [],
        },
      },
    };
    const p1 = catalogPage(c, "openrouter", { per: 50, picked: ["vendor/model-229"] });
    expect(p1).toMatchObject({ total: 230, page: 1, pages: 5, free_count: 77 });
    expect(p1.items[0]).toMatchObject({ id: "vendor/model-229", picked: true });
    expect(catalogPage(c, "openrouter", { per: 50, page: 9 }).page).toBe(5);
    expect(catalogPage(c, "openrouter", { free: true, per: 50 }).total).toBe(77);
    expect(catalogPage(c, "openrouter", { search: "model-12" }).items.map((x) => x.id)).toEqual(
      expect.arrayContaining(["vendor/model-120:free", "vendor/model-121"]),
    );
  });

  it("the settings page picks models, switches modes and the cost scope", async () => {
    const h = mkdtempSync(join(tmpdir(), "savant-cat-"));
    const cfg = newConfig("demo");
    saveConfig({ ...cfg, keys: { ...cfg.keys, OPENROUTER_API_KEY: "or-key" } }, h);
    const s = new LocalSettings({
      home: h,
      cfg: () => loadConfig(h) ?? newConfig("demo"),
      reload: () => undefined,
      pool: () => null,
      clef: () => ({ ok: false, level: "off", text: "off" }),
    });
    const v = (await s.catalog({ provider: "openrouter" })) as unknown as {
      providers: { id: string; mode: string }[];
    };
    expect(v.providers.map((p) => [p.id, p.mode])).toEqual([["openrouter", "recommended"]]);
    expect((await s.catalog({ provider: "openrouter", pick: ["qwen/qwen-3:free"] })).ok).toBe(true);
    expect(loadConfig(h)?.llm.prefs.models?.openrouter).toEqual({
      mode: "pick",
      picked: ["qwen/qwen-3:free"],
    });
    await s.catalog({ provider: "openrouter", unpick: ["qwen/qwen-3:free"], mode: "free" });
    expect(loadConfig(h)?.llm.prefs.models?.openrouter).toEqual({ mode: "free", picked: [] });
    await s.catalog({ cost_scope: "free_only" });
    expect(loadConfig(h)?.llm.prefs.cost_scope).toBe("free_only");
    expect((await s.catalog({ provider: "nobody", pick: ["x"] })).ok).toBe(false);
  });
});
