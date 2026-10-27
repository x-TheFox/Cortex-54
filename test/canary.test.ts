import { describe, expect, it } from "vitest";
import { goldenCase, hopsOf, runCanary } from "../src/court/canary.ts";
import type { LlmProvider } from "../src/court/llm.ts";
import { doctrine } from "./helpers.ts";

describe("model drift canary (ADR-070)", () => {
  it("one call per distinct hop; schema failures and errors are reported, missing keys skipped", async () => {
    expect(goldenCase(Date.now())).not.toBeNull();
    const hops = hopsOf(doctrine);
    expect(new Set(hops.map((h) => `${h.provider}/${h.model}`)).size).toBe(hops.length);
    const good: LlmProvider = {
      complete: async () => ({
        text: JSON.stringify({
          no_trade: false,
          thesis: "Listing volume confirms demand; invalid below 120.",
          setup: "breakout",
          entry_low: 123.5,
          entry_high: 124.5,
          stop: 120,
          targets: [130],
          horizon_hours: 48,
          conviction: 6,
          receipts: ["close", "atr14"],
        }),
        inputTokens: 1,
        outputTokens: 1,
      }),
    };
    const prose: LlmProvider = {
      complete: async () => ({ text: "I think it looks bullish.", inputTokens: 1, outputTokens: 1 }),
    };
    const down: LlmProvider = {
      complete: async () => {
        throw new Error("503 high demand");
      },
    };
    const r = await runCanary({ gemini: good, groq: prose, nim: down }, hops, Date.now());
    const by = (p: string) => r.results.filter((x) => x.provider === p);
    expect(by("gemini").every((x) => x.ok && x.schema_ok)).toBe(true);
    expect(by("groq").every((x) => x.ok && !x.schema_ok && /schema/.test(x.error ?? ""))).toBe(true);
    expect(by("nim").every((x) => !x.ok)).toBe(true);
    expect(by("openrouter")).toEqual([]);
  });
});
