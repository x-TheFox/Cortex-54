import { describe, expect, it } from "vitest";
import { NO_OBJECTION, parseTurn, runOpenCourt, type TurnReply, turnText } from "../src/court/open-court.ts";
import {
  CORE_SEATS,
  REST_PHRASES,
  relevance,
  SEAT_BY_ID,
  SPECIALISTS,
  shortlist,
} from "../src/court/roster.ts";
import { calc, htmlToText, publicUrl, toolBox } from "../src/court/tools.ts";

const seats = CORE_SEATS.slice(0, 4); // bull, bear, quant, risk
const brief = '<untrusted source="evidence">{}</untrusted>';

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe("open court (ADR-096)", () => {
  it("debates until every seat rests in the same pass, then stops", async () => {
    const c = clock();
    const said = new Map<string, number>();
    const r = await runOpenCourt({
      seats,
      caseBrief: brief,
      tools: toolBox({}, null),
      now: c.now,
      ask: async (seat) => {
        c.tick(1000);
        const n = (said.get(seat.id) ?? 0) + 1;
        said.set(seat.id, n);
        // everyone speaks twice, the quant three times, then rests
        const limit = seat.id === "quant" ? 3 : 2;
        const reply: TurnReply =
          n <= limit
            ? {
                action: "speak",
                statement: `${seat.title} point ${n}`,
                stance: "support",
                confidence: 0.6,
                tool_calls: [],
                withdraw: false,
              }
            : { action: "no_objection", statement: "", tool_calls: [], withdraw: false };
        return { reply, by: "fake/model" };
      },
    });
    expect(r.ended).toBe("unanimous");
    expect(r.passes).toBe(4); // pass 3: only the quant spoke; pass 4: all rested
    const rests = r.turns.filter((t) => t.kind === "rest");
    expect(rests.length).toBeGreaterThanOrEqual(4);
    // raw NO_OBJECTION never reaches a person
    for (const t of r.turns) expect(turnText(t)).not.toContain(NO_OBJECTION);
    for (const t of rests) expect(REST_PHRASES as readonly string[]).toContain(t.text);
    expect(r.stances.find((s) => s.seat === "quant")?.headline).toBe("Quant Analyst point 3");
  });

  it("lets a seat use tools as many times as it needs before speaking", async () => {
    const c = clock();
    let calls = 0;
    const r = await runOpenCourt({
      seats: seats.slice(2, 3),
      caseBrief: brief,
      tools: toolBox({ technicals: { atr14: 2.5 } }, null),
      now: c.now,
      ask: async (_s, req) => {
        calls++;
        if (calls === 1)
          return {
            reply: {
              action: "tools",
              statement: "",
              tool_calls: [{ tool: "calc", input: "(110-100)/(100-95)" }],
              withdraw: false,
            },
            by: "m",
          };
        if (calls === 2) {
          expect(req.user).toContain("calc((110-100)/(100-95)) → 2");
          return {
            reply: {
              action: "tools",
              statement: "",
              tool_calls: [{ tool: "evidence", input: "technicals.atr14" }],
              withdraw: false,
            },
            by: "m",
          };
        }
        if (calls === 3) {
          expect(req.user).toContain("evidence(technicals.atr14) → 2.5");
          return {
            reply: {
              action: "speak",
              statement: "Reward to risk is 2.0 per the calculator.",
              stance: "support",
              tool_calls: [],
              withdraw: false,
            },
            by: "m",
          };
        }
        return { reply: { action: "no_objection", statement: "", tool_calls: [], withdraw: false }, by: "m" };
      },
    });
    expect(r.ended).toBe("unanimous");
    expect(r.turns[0]?.tools.map((t) => t.tool)).toEqual(["calc", "evidence"]);
    expect(r.toolCalls).toBe(2);
  });

  it("calls time at 30 minutes and stops at the hard cutoff, handing the record to the jury", async () => {
    const c = clock();
    let sawDirective = false;
    const r = await runOpenCourt({
      seats,
      caseBrief: brief,
      tools: toolBox({}, null),
      now: c.now,
      ask: async (seat, req) => {
        c.tick(4 * 60_000); // each turn takes 4 minutes, and nobody ever rests
        if (req.user.includes("time is up")) sawDirective = true;
        return {
          reply: { action: "speak", statement: `${seat.id} again`, tool_calls: [], withdraw: false },
          by: "m",
        };
      },
    });
    expect(r.ended).toBe("hard_cutoff");
    expect(sawDirective).toBe(true);
    expect(r.turns.some((t) => t.kind === "directive")).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(35 * 60_000);
    expect(r.ms).toBeLessThan(45 * 60_000);
  });

  it("ends when the bull withdraws; a seat whose models never answer drops off the floor", async () => {
    const c = clock();
    const r = await runOpenCourt({
      seats,
      caseBrief: brief,
      tools: toolBox({}, null),
      now: c.now,
      ask: async (seat, _req, pass) => {
        if (seat.id === "risk") return null;
        if (seat.id === "bull" && pass === 2)
          return {
            reply: {
              action: "speak",
              statement: "The bear is right about the gap risk; I withdraw.",
              tool_calls: [],
              withdraw: true,
            },
            by: "m",
          };
        return { reply: { action: "speak", statement: "point", tool_calls: [], withdraw: false }, by: "m" };
      },
    });
    expect(r.ended).toBe("withdrawn");
    expect(r.turns.filter((t) => t.seat === "risk" && t.kind === "absent")).toHaveLength(1);
  });

  it("compacts a long record so a seat's context stays bounded", async () => {
    const c = clock();
    let maxUser = 0;
    let summaries = 0;
    let n = 0;
    await runOpenCourt({
      seats,
      caseBrief: brief,
      tools: toolBox({}, null),
      now: c.now,
      maxContextChars: 5_000,
      summarize: async () => {
        summaries++;
        return "The bull argued momentum; the bear argued gap risk; the quant confirmed 2.0 reward to risk.";
      },
      ask: async (_s, req) => {
        maxUser = Math.max(maxUser, req.user.length);
        n++;
        return n > 40
          ? { reply: { action: "no_objection", statement: "", tool_calls: [], withdraw: false }, by: "m" }
          : {
              reply: { action: "speak", statement: "x".repeat(900), tool_calls: [], withdraw: false },
              by: "m",
            };
      },
    });
    expect(summaries).toBeGreaterThan(0);
    expect(maxUser).toBeLessThan(8_000);
  });

  it("parses the bare word and refuses empty turns", () => {
    expect(parseTurn("NO_OBJECTION").action).toBe("no_objection");
    expect(parseTurn({ action: "speak", statement: "NO_OBJECTION" }).action).toBe("no_objection");
    expect(() => parseTurn({ action: "tools" })).toThrow();
    expect(() => parseTurn({ action: "speak", statement: "" })).toThrow();
  });
});

describe("courtroom roster (ADR-096)", () => {
  it("has the core seats and 100+ distinct specialists", () => {
    expect(CORE_SEATS.map((s) => s.id)).toEqual([
      "bull",
      "bear",
      "quant",
      "risk",
      "macro",
      "devil",
      "execution",
      "clerk",
    ]);
    expect(SPECIALISTS.length).toBeGreaterThanOrEqual(100);
    expect(SEAT_BY_ID.size).toBe(CORE_SEATS.length + SPECIALISTS.length); // ids are unique
    for (const s of SPECIALISTS) {
      expect(s.tags.length).toBeGreaterThan(0);
      expect(s.brief.length).toBeGreaterThan(20);
    }
  });

  it("shortlists the specialists a case touches, by arena", () => {
    const fda = shortlist(
      { arena: "EQUITIES", symbol: "XBIO", text: "FDA approval for Phase 3 drug after trial data readout" },
      5,
    );
    expect(fda[0]?.id).toBe("biotech");
    const hack = shortlist(
      { arena: "CRYPTO", symbol: "ETH/USD", text: "Bridge exploit: $200M drained in hack" },
      5,
    ).map((s) => s.id);
    expect(hack).toContain("crypto_security");
    expect(hack).not.toContain("earnings");
    expect(
      relevance(SEAT_BY_ID.get("earnings") as never, {
        arena: "CRYPTO",
        symbol: "BTC/USD",
        text: "earnings",
      }),
    ).toBe(0);
  });
});

describe("court tools (ADR-096)", () => {
  it("calc is arithmetic only", () => {
    expect(calc("(110 - 100) / (100 - 95)")).toBe(2);
    expect(calc("2^3^2")).toBe(512);
    expect(calc("-3 + sqrt(16) * 2")).toBe(5);
    expect(calc("0.3% * 18")).toBeCloseTo(0.054, 10);
    expect(calc("max(1, 2, 3)")).toBe(3);
    expect(() => calc("process.exit()")).toThrow();
    expect(() => calc("1/0")).toThrow();
    expect(() => calc("constructor")).toThrow();
  });

  it("reads only public addresses", () => {
    expect(publicUrl("https://www.sec.gov/x")).not.toBeNull();
    for (const bad of [
      "http://localhost:8754/api",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "file:///etc/passwd",
      "http://user:pw@example.com/",
      "http://2130706433/",
      "http://metadata.google.internal/",
    ])
      expect(publicUrl(bad)).toBeNull();
  });

  it("network tools without a fetcher say so; results are capped and cached", async () => {
    const box = toolBox({}, null);
    const r = await box.run({ tool: "web_search", input: "btc" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not available/);
    let fetched = 0;
    const page = `<html><title>Big news</title><script>evil()</script><p>${"word ".repeat(3000)}</p></html>`;
    const net = toolBox({}, async () => {
      fetched++;
      return new Response(page, { headers: { "content-type": "text/html" } });
    });
    const a = await net.run({ tool: "read_url", input: "https://example.com/a" });
    expect(a.ok).toBe(true);
    expect(a.output.startsWith("Big news")).toBe(true);
    expect(a.output).not.toContain("evil");
    expect(a.output.length).toBeLessThanOrEqual(4_010);
    await net.run({ tool: "read_url", input: "https://example.com/a" });
    expect(fetched).toBe(1);
    expect((await net.run({ tool: "read_url", input: "http://127.0.0.1/" })).ok).toBe(false);
    expect(htmlToText("<b>a &amp; b</b>").text).toBe("a & b");
  });
});
