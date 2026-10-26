import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyKeys, loadConfig, newConfig, saveConfig } from "../local/config.ts";
import { jobFor, LocalJobs } from "../local/jobs.ts";
import { LocalCortex } from "../local/runtime.ts";
import { plan } from "../local/service.ts";
import { SimBroker } from "../local/simbroker.ts";
import { fileD1, fileSql } from "../local/store.ts";
import { hmacHex } from "../src/lib/hmac.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { FakeMarketData, Market } from "./sim/FakeBroker.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "c54-local-"));

describe("local config (ADR-064)", () => {
  it("creates secrets, saves 0600, applies KEY=VALUE, refuses unknown names, removes on empty", () => {
    const home = tmp();
    let cfg = newConfig("demo");
    expect(cfg.secrets.web_session.length).toBeGreaterThanOrEqual(32);
    cfg = applyKeys(cfg, ["GROQ_API_KEY=gsk_x", "GEMINI_API_KEY=g"]);
    expect(() => applyKeys(cfg, ["GROQ_KEY=x"])).toThrow(/unknown key GROQ_KEY/);
    cfg = applyKeys(cfg, ["GEMINI_API_KEY="]);
    saveConfig(cfg, home);
    const back = loadConfig(home);
    expect(back?.keys).toEqual({ GROQ_API_KEY: "gsk_x" });
    expect(loadConfig(tmp())).toBeNull();
  });
});

describe("local job runner (ADR-064)", () => {
  const ctx = {
    researchDir: "/app/research",
    home: "/h",
    url: "http://127.0.0.1:8754",
    cfg: applyKeys(newConfig("paper"), ["ALPACA_PAPER_KEY_ID=k", "ALPACA_PAPER_SECRET=s", "GROQ_API_KEY=g"]),
  };
  it("maps every dispatched workflow to a local uv command with the local ingest URL and secret", () => {
    const d = jobFor(
      "research.yml",
      { job: "dossier", symbol: "NVDA", arena: "EQUITIES", mode: "watch", depth: "quick", kill: "a|b" },
      ctx,
    );
    expect(d?.cmd).toBe("uv");
    expect(d?.args).toEqual([
      "run",
      "--directory",
      "/app/research",
      "python",
      "-m",
      "cortex_research.run",
      "dossier",
    ]);
    expect(d?.env).toMatchObject({
      CORTEX_URL: "http://127.0.0.1:8754",
      DOSSIER_SYMBOL: "NVDA",
      DOSSIER_MODE: "watch",
      DOSSIER_KILL: "a|b",
      ALPACA_KEY_ID: "k",
      GROQ_API_KEY: "g",
    });
    expect(d?.env.INGEST_HMAC_SECRET).toBe(ctx.cfg.secrets.ingest_hmac);
    expect(jobFor("research.yml", { job: "crypto" }, ctx)?.vendor).toBe("upstream");
    expect(jobFor("research.yml", { job: "kronos" }, ctx)?.args).toContain("kronos");
    expect(jobFor("research.yml", { job: "options" }, ctx)?.args.at(-1)).toBe("cortex_research.options.lab");
    expect(jobFor("governor.yml", { weekly: "true" }, ctx)?.args.slice(-2)).toEqual([
      "cortex_research.governor.run",
      "--weekly",
    ]);
    expect(jobFor("research.yml", { job: "rm -rf" }, ctx)).toBeNull();
    expect(jobFor("other.yml", {}, ctx)).toBeNull();
  });

  it("one run per job key at a time, a parallel cap, and a disabled switch", async () => {
    const started: string[] = [];
    const fakeSpawn = ((cmd: string, a: string[]) => {
      started.push(`${cmd} ${a.at(-1)}`);
      const listeners: Record<string, (x: unknown) => void> = {};
      return { stdout: null, stderr: null, on: (ev: string, f: (x: unknown) => void) => (listeners[ev] = f) };
    }) as unknown as typeof import("node:child_process").spawn;
    const jobs = new LocalJobs({ ...ctx, home: tmp() }, fakeSpawn);
    await jobs.dispatch("research.yml", { job: "world" });
    await jobs.dispatch("research.yml", { job: "world" }); // already running: no second copy
    await jobs.dispatch("research.yml", { job: "backtest" });
    await expect(jobs.dispatch("research.yml", { job: "dossier", symbol: "X" })).rejects.toThrow(
      /slots full/,
    );
    expect(started).toEqual(["uv world", "uv backtest"]);
    const off = new LocalJobs(
      { ...ctx, cfg: { ...ctx.cfg, research: { enabled: false, max_parallel: 2 } } },
      fakeSpawn,
    );
    await expect(off.dispatch("research.yml", { job: "world" })).rejects.toThrow(/disabled/);
  });
});

describe("background service plans (ADR-064)", () => {
  const argv = ["/usr/bin/node", "--import", "tsx", "/app/local/cli.ts", "start"];
  it("launchd keeps it alive and logs to the CORTEX home", () => {
    const p = plan("darwin", argv, { CORTEX_HOME: "/Users/x/.cortex54" }, "/Users/x");
    expect(p.file).toBe("/Users/x/Library/LaunchAgents/com.cortex54.daemon.plist");
    expect(p.content).toContain("<key>KeepAlive</key><true/>");
    expect(p.content).toContain("<string>/app/local/cli.ts</string>");
    expect(p.enable[0]).toEqual(["launchctl", "load", "-w", p.file]);
  });
  it("systemd user unit restarts on failure; Windows uses an at-logon task", () => {
    const l = plan("linux", argv, { CORTEX_HOME: "/home/x/.cortex54" }, "/home/x");
    expect(l.content).toContain("Restart=always");
    expect(l.enable.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "cortex54.service"]);
    const w = plan("win32", argv, { CORTEX_HOME: "C:\\Users\\x\\.cortex54" });
    expect(w.enable[0]?.slice(0, 5)).toEqual(["schtasks", "/Create", "/F", "/SC", "ONLOGON"]);
  });
});

describe("local storage (ADR-064)", () => {
  it("applies the real D1 migrations once, keeps the append-only triggers, persists across reopen", async () => {
    const home = tmp();
    const d1 = fileD1(join(home, "j.sqlite"), "migrations");
    await d1.batch([
      d1
        .prepare(
          "INSERT INTO journal (seq, ts, account, kind, ref_id, payload_json, prev_row_sha256, row_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(1, 1, "SYSTEM", "BOOT", null, "{}", "0", "a"),
    ]);
    await expect(d1.batch([d1.prepare("DELETE FROM journal").bind()])).rejects.toThrow();
    const again = fileD1(join(home, "j.sqlite"), "migrations");
    expect((await again.prepare("SELECT COUNT(*) AS n FROM journal").bind().first<{ n: number }>())?.n).toBe(
      1,
    );
  });
});

function bars(n: number, p: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: Date.now() - (n - i) * 86_400_000,
    o: p,
    h: p + 1,
    l: p - 1,
    c: p,
    v: 1,
  }));
}

describe("keyless sandbox broker (ADR-064)", () => {
  it("fills marketable limits at the touch, rests the rest, survives a restart", async () => {
    const sql = fileSql(join(tmp(), "h.sqlite"));
    sql.exec(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    const m = new Market(() => Date.now());
    m.set("BTC/USD", 100, 100.1);
    const b = new SimBroker(sql, new FakeMarketData(m), 54);
    const buy = await b.submitOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      time_in_force: "gtc",
      qty: "0.1",
      limit_price: "100.2",
      client_order_id: "c1",
    });
    expect(buy.status).toBe("filled");
    await b.submitOrder({
      symbol: "BTC/USD",
      side: "sell",
      type: "limit",
      time_in_force: "gtc",
      qty: "0.1",
      limit_price: "105",
      client_order_id: "c2",
    });
    expect((await b.openOrders()).map((o) => o.client_order_id)).toEqual(["c2"]);
    await expect(
      b.submitOrder({
        symbol: "BTC/USD",
        side: "buy",
        type: "limit",
        time_in_force: "gtc",
        qty: "1",
        limit_price: "1",
        client_order_id: "c1",
      }),
    ).rejects.toThrow(/unique/);
    m.set("BTC/USD", 105.5, 105.6);
    const reopened = new SimBroker(sql, new FakeMarketData(m), 54);
    expect(await reopened.positions()).toEqual([]);
    expect(Number((await reopened.account()).cash)).toBeCloseTo(54 - 10.01 + 10.55, 2);
    await expect(
      b.submitOrder({
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        qty: "1",
        limit_price: "1",
        client_order_id: "c9",
      }),
    ).rejects.toThrow(/crypto only/);
  });
});

describe("cortexd runtime (ADR-064)", () => {
  const make = () => {
    const home = tmp();
    const m = new Market(() => Date.now());
    m.bars["BTC/USD"] = bars(40, 100);
    m.set("BTC/USD", 100, 100.05);
    const cfg = { ...newConfig("demo"), research: { enabled: false, max_parallel: 1 } };
    return {
      home,
      cfg,
      c: new LocalCortex({
        home,
        root: process.cwd(),
        cfg,
        overrides: { market: new FakeMarketData(m), clef: null, quiet: true },
      }),
    };
  };

  it("pulses the same Brain with a simulated broker and serves health", async () => {
    const { c } = make();
    const r = await c.pulse();
    expect(r.accounts.PAPER?.ok).toBe(true);
    const h = (await (await c.route(new Request("http://x/health"), new URL("http://x/health"))).json()) as {
      mode: string;
      last_pulse_at: number;
    };
    expect(h.mode).toBe("demo");
    expect(h.last_pulse_at).toBeGreaterThan(0);
  });

  it("ingest needs the local HMAC; the static server can't leave public/", async () => {
    const { c, cfg } = make();
    const body = JSON.stringify({ schema_version: 1, job: "nope" });
    const bad = await c.route(
      new Request("http://x/ingest/batch", { method: "POST", body }),
      new URL("http://x/ingest/batch"),
    );
    expect(bad.status).toBe(401);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${await hmacHex(cfg.secrets.ingest_hmac, `${ts}.${body}`)}`;
    const good = await c.route(
      new Request("http://x/ingest/batch", {
        method: "POST",
        body,
        headers: { "x-cortex-timestamp": ts, "x-cortex-signature": sig },
      }),
      new URL("http://x/ingest/batch"),
    );
    expect(good.status).toBe(422); // authenticated, then refused by the batch schema
    const traversal = await c.route(
      new Request("http://x/..%2f..%2fpackage.json"),
      new URL("http://x/..%2f..%2fpackage.json"),
    );
    expect(await traversal.text()).not.toContain('"devDependencies"');
  });

  it("the local kill file stops new entries", async () => {
    const { c, home } = make();
    writeFileSync(join(home, "KILLED"), "test");
    expect((await c.pulse()).kill).toBe("KILLED");
  });
});
