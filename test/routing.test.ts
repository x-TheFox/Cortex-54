import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { assertionCommand, PowerGuard } from "../local/power.ts";
import { KeyPoolProvider, splitKeys } from "../src/court/keypool.ts";
import { type LlmProvider, LlmRouter, ProviderError } from "../src/court/llm.ts";
import { doctrine } from "./helpers.ts";

const req = { system: "s", user: "u", maxOutputTokens: 10, schema: {} };
const ok = (tag: string, calls: string[]): LlmProvider => ({
  async complete() {
    calls.push(tag);
    return { text: JSON.stringify({ ok: tag }), inputTokens: 1, outputTokens: 1 };
  },
});
const failing = (status: number, tag: string, calls: string[]): LlmProvider => ({
  async complete() {
    calls.push(tag);
    throw new ProviderError(tag, status, "nope");
  },
});

describe("two-tier round robin (ADR-097)", () => {
  it("inner tier: keys take turns; a 429 or 401 key is skipped and the next key answers at once", async () => {
    let t = 0;
    const calls: string[] = [];
    const pool = new KeyPoolProvider(
      "groq",
      [ok("k1", calls), failing(429, "k2", calls), failing(401, "k3", calls)],
      () => t,
    );
    await pool.complete("m", req, 1000); // k1
    await pool.complete("m", req, 1000); // k2 429 → k3 401 → k1
    expect(calls).toEqual(["k1", "k2", "k3", "k1"]);
    expect(pool.healthy()).toBe(1);
    t += 61_000; // k2's rate limit is over, k3 (revoked) still set aside
    expect(pool.healthy()).toBe(2);
  });

  it("all keys exhausted → the provider reports 429, and the router moves to the next provider", async () => {
    const t = 0;
    const calls: string[] = [];
    const groq = new KeyPoolProvider("groq", [failing(429, "g1", calls), failing(429, "g2", calls)], () => t);
    const d = {
      ...doctrine,
      llm_routing: {
        ...doctrine.llm_routing,
        families: { groq: "a", gemini: "b" },
        bull_chain: [
          { provider: "groq", model: "m" },
          { provider: "gemini", model: "m" },
        ],
        bear_chain: [{ provider: "gemini", model: "m" }],
        panel: { ...doctrine.llm_routing.panel, chain: [] },
      },
    };
    const router = new LlmRouter({ groq, gemini: ok("gem", calls) }, d, () => t);
    const r = await router.run(
      d.llm_routing.bull_chain,
      req,
      (j) => j,
      [],
      () => undefined,
    );
    expect(r?.provider).toBe("gemini");
    expect(calls).toEqual(["g1", "g2", "gem"]);
    expect(router.providerStatus().find((p) => p.provider === "groq")?.cooling_until).toBeGreaterThan(t);
    expect(router.depleted()).toBe(false);
  });

  it("every provider exhausted → depleted (the brain holds new entries) until a cooldown ends", async () => {
    let t = 0;
    const d = {
      ...doctrine,
      llm_routing: {
        ...doctrine.llm_routing,
        families: { a: "x", b: "y" },
        bull_chain: [{ provider: "a", model: "m" }],
        bear_chain: [{ provider: "b", model: "m" }],
        panel: { ...doctrine.llm_routing.panel, chain: [] },
      },
    };
    const calls: string[] = [];
    const router = new LlmRouter(
      {
        a: new KeyPoolProvider("a", [failing(429, "a1", calls), failing(429, "a2", calls)], () => t),
        b: failing(429, "b", calls),
      },
      d,
      () => t,
    );
    expect(
      await router.run(
        [...d.llm_routing.bull_chain, ...d.llm_routing.bear_chain],
        req,
        (j) => j,
        [],
        () => undefined,
      ),
    ).toBeNull();
    expect(router.depleted()).toBe(true);
    t += router.cooldownMs + 1;
    expect(router.depleted()).toBe(false);
  });

  it("several keys in one field become one pool", () => {
    expect(splitKeys("gsk_a, gsk_b\ngsk_c;gsk_a")).toEqual(["gsk_a", "gsk_b", "gsk_c"]);
    expect(splitKeys("")).toEqual([]);
  });
});

describe("power assertion (ADR-096)", () => {
  it("uses each platform's own helper, tied to Savant's process", () => {
    expect(assertionCommand("darwin", 42, "x")).toEqual(["caffeinate", ["-i", "-s", "-w", "42"]]);
    expect(assertionCommand("win32", 42, "x")?.[1].join(" ")).toContain("Wait-Process -Id 42");
    expect(assertionCommand("linux", 42, "x")?.[0]).toBe("systemd-inhibit");
    expect(assertionCommand("aix", 42, "x")).toBeNull();
  });

  it("holds while there is a reason and releases when none is left", () => {
    const spawned: { killed: boolean }[] = [];
    const g = new PowerGuard(
      () => {
        const c = Object.assign(new EventEmitter(), {
          killed: false,
          kill() {
            this.killed = true;
            return true;
          },
          unref() {},
        });
        spawned.push(c);
        return c as never;
      },
      "darwin",
      1,
    );
    g.set("court", true);
    g.set("court", true);
    g.hold("always");
    expect(spawned).toHaveLength(1);
    g.release("court");
    expect(g.held).toBe(true);
    g.release("always");
    expect(g.held).toBe(false);
    expect(spawned[0]?.killed).toBe(true);
  });
});
