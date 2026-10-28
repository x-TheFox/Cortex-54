import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StatusView } from "../src/cortex/Brain.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { ntfyUrl, PushNotifier, pushText } from "../src/notify/push.ts";
import { pill, pillAuthorized, swiftbar } from "../src/web/pill.ts";

const status = (over: Partial<StatusView> = {}): StatusView =>
  ({
    now: 1_000_000,
    lastPulseAt: 1_000_000 - 61_000,
    budget: { mode: "NORMAL" },
    journalHead: { seq: 1, sha: "x" },
    outboxPending: 0,
    equity: {},
    regimes: [
      {
        arena: "CRYPTO",
        posture: "REDUCE_ONLY",
        score: 30,
        ceiling: null,
        ageMinutes: 10,
        fresh: true,
        source: "x",
      },
    ],
    accounts: [
      {
        account: "PAPER",
        configured: true,
        equityUsd: 54.12,
        brokerEquityUsd: 54.2,
        modeledCostUsd: 0.08,
        hwmUsd: 54.3,
        rung: "R1",
        autonomyStop: 2,
        breaker: "GREEN",
        locked: false,
        mode: "NORMAL",
        modeReason: null,
        reconciledAt: 1,
        lastError: null,
        ordersToday: 0,
        positions: [
          {
            symbol: "DOT/USD",
            qty: "3",
            avgEntry: "3.3",
            stop: "3.1",
            target: "3.6",
            state: "OPEN",
            brokerStop: true,
          },
        ],
        openOrders: [],
      },
      { account: "LIVE", configured: false } as StatusView["accounts"][number],
    ],
    ...over,
  }) as StatusView;

describe("pulse pill (ADR-062)", () => {
  it("summarizes configured accounts, regimes and holdings; flags a stale pulse", () => {
    const p = pill(status());
    expect(p).toMatchObject({ ok: true, pulse_age_s: 61, budget: "NORMAL", symbols: ["DOT/USD"] });
    expect(p.accounts).toEqual([
      { account: "PAPER", equity: 54.12, positions: 1, breaker: "GREEN", dial: 2, mode: "NORMAL" },
    ]);
    expect(pill(status({ lastPulseAt: 1_000_000 - 3_600_000 })).ok).toBe(false);
    const sb = swiftbar(p, "https://cortex.test/");
    expect(sb.split("\n")[0]).toBe("🟢 C54 $54.12 · 1");
    expect(sb).toContain("CRYPTO: REDUCE_ONLY");
    expect(sb).toContain("Open web terminal | href=https://cortex.test/");
  });

  it("bearer auth: exact token only, long tokens only", () => {
    const tok = "a".repeat(32);
    expect(pillAuthorized(`Bearer ${tok}`, tok)).toBe(true);
    expect(pillAuthorized(`Bearer ${tok}x`, tok)).toBe(false);
    expect(pillAuthorized(tok, tok)).toBe(false);
    expect(pillAuthorized("Bearer short", "short")).toBe(false); // a weak token disables the endpoint
    expect(pillAuthorized(`Bearer ${tok}`, undefined)).toBe(false);
  });

  it("the SwiftBar plugin renders the server's menu with nothing but curl", async () => {
    const tok = "t".repeat(32);
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${tok}`) return void res.writeHead(401).end();
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end(swiftbar(pill(status()), "https://cortex.test/"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), "c54pill-"));
    writeFileSync(join(home, ".cortex54-pill"), `http://127.0.0.1:${port}\n${tok}\n`);
    const out = await new Promise<string>((resolve) => {
      const p = spawn("bash", ["tools/widgets/swiftbar/cortex.30s.sh"], {
        env: { ...process.env, HOME: home },
      });
      let buf = "";
      p.stdout.on("data", (d) => (buf += d));
      p.on("close", () => resolve(buf));
    });
    server.close();
    expect(out.split("\n")[0]).toBe("🟢 C54 $54.12 · 1");
  });
});

describe("ntfy push alerts (ADR-062)", () => {
  it("only long random topics turn it on; https bases only", () => {
    expect(ntfyUrl(undefined, undefined)).toBeNull();
    expect(ntfyUrl("short", undefined)).toBeNull();
    expect(ntfyUrl("c54_8f3a9d2e71b04c56", undefined)).toBe("https://ntfy.sh/c54_8f3a9d2e71b04c56");
    expect(ntfyUrl("c54_8f3a9d2e71b04c56", "https://ntfy.example.org")).toBe(
      "https://ntfy.example.org/c54_8f3a9d2e71b04c56",
    );
    expect(ntfyUrl("c54_8f3a9d2e71b04c56", "http://evil")).toBe("https://ntfy.sh/c54_8f3a9d2e71b04c56");
  });

  it("forwards alarms, executions and rulings; skips the noisy channels; Discord still gets everything", async () => {
    const inner = new NullNotifier();
    const pushes: { url: string; headers: Record<string, string>; body: string }[] = [];
    const n = new PushNotifier(
      inner,
      "https://ntfy.sh/topic_abcdefghijklmnop",
      () => undefined,
      async (url, init) => {
        pushes.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
          body: String(init?.body),
        });
        return new Response("ok");
      },
    );
    await n.post("alarms", { content: "⚠️ PAPER broker sync failed: 503" });
    await n.post("executions", {
      embeds: [{ title: "✅ PAPER closed · DOT/USD", description: "reason TARGET · P&L $0.42" }],
    });
    await n.post("court", {
      embeds: [
        { title: "⚖️ Savant COURT" },
        {
          title: "🔨 RULING — trade approved",
          fields: [{ name: "Accounts", value: "PAPER: entry order placed" }],
        },
      ],
    });
    await n.post("court", { embeds: [{ title: "📚 Research desk — BTC/USD" }] });
    await n.post("terminal", { content: "noise" });
    await n.post("world_intel", { embeds: [{ title: "intel" }] });
    expect(inner.sent).toHaveLength(6);
    expect(pushes.map((p) => p.headers.priority)).toEqual(["4", "3", "3"]);
    expect(pushes[1]?.headers.title).toBe("PAPER closed  DOT/USD"); // ASCII-only header
    expect(pushes[1]?.body).toContain("P&L $0.42");
    expect(pushes[2]?.body).toContain("PAPER: entry order placed");
  });

  it("a failing push never fails the post", async () => {
    const inner = new NullNotifier();
    const n = new PushNotifier(
      inner,
      "https://ntfy.sh/topic_abcdefghijklmnop",
      () => undefined,
      async () => {
        throw new Error("down");
      },
    );
    await expect(n.post("alarms", { content: "x" })).resolves.toBeNull();
    expect(pushText({ embeds: [{ title: "**T**", description: "see [link](https://x)" }] })).toEqual({
      title: "T",
      body: "see link",
    });
  });
});

describe("buy-and-hold benchmark (MLP0-024)", () => {
  it("scales BTC and SPY to the account's first equity sample and skips gaps", async () => {
    const { benchmarkLines, equityChartUrl } = await import("../src/cortex/Brain.ts");
    const eq = [
      [1000, 54],
      [2000, 55],
    ];
    const b = benchmarkLines(eq, [
      { at: 500, btc: 50, spy: 400 },
      { at: 1000, btc: 100, spy: null },
      { at: 2000, btc: 110, spy: 420 },
    ]);
    expect(b.btc).toEqual([
      [1000, 54],
      [2000, 59.4],
    ]);
    expect(b.spy).toEqual([[2000, 54]]); // starts where SPY first has a price
    expect(benchmarkLines([], [])).toEqual({ btc: [], spy: [] });
    const url = equityChartUrl(eq, b) as string;
    expect(decodeURIComponent(url)).toContain('"label":"BTC hold"');
  });
});
