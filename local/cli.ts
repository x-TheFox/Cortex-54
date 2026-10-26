import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AlpacaClient } from "../src/broker/AlpacaClient.ts";
import { buildProviders } from "../src/court/providers.ts";
import {
  applyKeys,
  cortexHome,
  type KEY_NAMES,
  keyNames,
  type LocalConfig,
  loadConfig,
  newConfig,
  saveConfig,
} from "./config.ts";
import { deploy } from "./deploy.ts";
import { LocalJobs } from "./jobs.ts";
import { claimOnce } from "./runner.ts";
import { LocalCortex } from "./runtime.ts";
import { install, plan, uninstall } from "./service.ts";

/**
 * `cortex` — the CORTEX-54 command line (ADR-064). Every command has a plain-text and a `--json` form so a human or
 * an AI agent can drive setup end to end (docs/SETUP_WITH_AN_AGENT.md).
 *
 *   cortex setup [--mode demo|paper] [--set KEY=VALUE ...] [--yes]   create or update ~/.cortex54/config.json
 *   cortex doctor [--json]                                           check everything, say exactly what to fix
 *   cortex start                                                     run the brain + web terminal (foreground)
 *   cortex demo [--minutes N]                                        keyless demo in a throwaway home
 *   cortex link                                                      one-time login link for the web terminal
 *   cortex service install|uninstall|print                           run at login, restart on crash
 *   cortex kill [reason] | cortex rearm                              local kill switch (blocks all entries)
 *   cortex keys                                                      list which key names are set (never values)
 *   cortex deploy [--name cortex]                                    deploy brain + sentinel to YOUR Cloudflare account
 *   cortex runner                                                    run the cloud brain's research jobs on this machine
 */

// CORTEX_ROOT points at the app's bundled resources (desktop app / packaged builds); from source it's the repo
const ROOT = process.env.CORTEX_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const multi = (n: string) =>
  args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1] as string] : []));
const json = flag("json");
const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function portFree(port: number, bind: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, bind, () => s.close(() => res(true)));
  });
}

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

async function doctor(home: string): Promise<Check[]> {
  const c: Check[] = [];
  const [maj, min] = process.versions.node.split(".").map(Number) as [number, number];
  c.push({
    name: "node",
    ok: maj > 22 || (maj === 22 && min >= 13),
    detail: process.versions.node,
    fix: "Install Node 22.13+ (node:sqlite).",
  });
  const cfg = (() => {
    try {
      return loadConfig(home);
    } catch (e) {
      c.push({
        name: "config",
        ok: false,
        detail: String(e).slice(0, 200),
        fix: "Run `cortex setup` to rewrite it.",
      });
      return undefined;
    }
  })();
  if (cfg === null)
    c.push({
      name: "config",
      ok: false,
      detail: `no config in ${home}`,
      fix: "Run `cortex setup --mode demo --yes` (no keys needed) or `cortex setup` for paper trading.",
    });
  c.push({
    name: "web terminal",
    ok: existsSync(join(ROOT, "public", "index.html")),
    detail: join(ROOT, "public"),
    fix: "Run `pnpm web:build`.",
  });
  c.push({
    name: "uv (research jobs)",
    ok: has("uv"),
    detail: has("uv") ? "found" : "missing",
    fix: "Install uv (https://docs.astral.sh/uv/) — research, Kronos and the Governor run with it.",
  });
  c.push({
    name: "git (pinned research skills)",
    ok: has("git"),
    detail: has("git") ? "found" : "missing",
    fix: "Install git.",
  });
  if (cfg) {
    c.push({ name: "mode", ok: true, detail: cfg.mode });
    c.push({
      name: "port",
      ok: await portFree(cfg.port, cfg.bind),
      detail: `${cfg.bind}:${cfg.port}`,
      fix: "Another process uses the port (a running cortexd?), or change `port` in config.json.",
    });
    const k = cfg.keys;
    if (cfg.mode === "paper") {
      if (!k.ALPACA_PAPER_KEY_ID || !k.ALPACA_PAPER_SECRET)
        c.push({
          name: "alpaca paper keys",
          ok: false,
          detail: "missing",
          fix: "Create a free Alpaca paper account and run `cortex setup --set ALPACA_PAPER_KEY_ID=… --set ALPACA_PAPER_SECRET=…`.",
        });
      else {
        try {
          const a = await new AlpacaClient(
            "https://paper-api.alpaca.markets",
            { keyId: k.ALPACA_PAPER_KEY_ID, secret: k.ALPACA_PAPER_SECRET },
            () => undefined,
          ).account();
          c.push({
            name: "alpaca paper keys",
            ok: a.status === "ACTIVE",
            detail: `account ${a.status}, equity $${a.equity}`,
          });
        } catch (e) {
          c.push({
            name: "alpaca paper keys",
            ok: false,
            detail: String(e).slice(0, 160),
            fix: "Check the keys (paper, not live) in the Alpaca dashboard.",
          });
        }
      }
    }
    const providers = Object.keys(buildProviders(k));
    c.push({
      name: "court models",
      ok: providers.length >= 2,
      detail: providers.join(", ") || "none",
      fix: "The court needs two model families: add any two of GEMINI_API_KEY / GROQ_API_KEY (free) or ANTHROPIC_API_KEY / OPENAI_API_KEY (your own paid keys).",
    });
    const clef =
      k.CLOUDFLARE_ACCOUNT_ID && k.CLOUDFLARE_API_TOKEN
        ? "Cloudflare Workers AI"
        : providers.length
          ? "shim on your chat model"
          : "off";
    c.push({
      name: "Clef (Tier 1/2 + judge)",
      ok: clef !== "off",
      detail: clef,
      fix: "Add CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (free Workers AI), or any chat model key for the shim.",
    });
    c.push({
      name: "kill switch",
      ok: !existsSync(join(home, "KILLED")),
      detail: existsSync(join(home, "KILLED")) ? "KILLED" : "clear",
      fix: "`cortex rearm` when you mean it.",
    });
  }
  return c;
}

async function setup(home: string): Promise<void> {
  let cfg = loadConfig(home) ?? newConfig("demo");
  const mode = opt("mode");
  if (mode === "demo" || mode === "paper") cfg = { ...cfg, mode };
  // headless/server installs (Docker, a VPS): listen beyond localhost; put TLS in front (docs/SELF_HOSTING.md)
  const bind = opt("bind");
  if (bind) cfg = { ...cfg, bind };
  if (opt("port")) cfg = { ...cfg, port: Number(opt("port")) };
  cfg = applyKeys(cfg, multi("set"));
  if (!flag("yes") && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q: string, d = "") => (await rl.question(`${q}${d ? ` [${d}]` : ""}: `)).trim() || d;
    console.log(
      "CORTEX-54 setup — press Enter to keep a value. Keys stay on this machine (config.json, mode 600).\n",
    );
    const m = await ask(
      "Mode: demo (no keys, simulated broker) or paper (your Alpaca paper account)",
      cfg.mode,
    );
    cfg = { ...cfg, mode: m === "paper" ? "paper" : "demo" };
    const prompts: [(typeof KEY_NAMES)[number], string][] = [
      ["ALPACA_PAPER_KEY_ID", "Alpaca PAPER key id (paper mode, also unlocks news + stocks)"],
      ["ALPACA_PAPER_SECRET", "Alpaca PAPER secret"],
      ["GEMINI_API_KEY", "Gemini API key (free tier works)"],
      ["GROQ_API_KEY", "Groq API key (free tier works)"],
      ["ANTHROPIC_API_KEY", "Anthropic API key (optional, your own paid key)"],
      ["OPENAI_API_KEY", "OpenAI API key (optional)"],
      ["CLOUDFLARE_ACCOUNT_ID", "Cloudflare account id (optional: real Clef via free Workers AI)"],
      ["CLOUDFLARE_API_TOKEN", "Cloudflare API token with Workers AI permission"],
      ["NTFY_TOPIC", "ntfy topic for phone alerts (optional, 16+ random chars)"],
    ];
    for (const [k, label] of prompts) {
      const v = await ask(`${label}${cfg.keys[k] ? " (set)" : ""}`);
      if (v) cfg = applyKeys(cfg, [`${k}=${v}`]);
    }
    rl.close();
  }
  const p = saveConfig(cfg, home);
  out(
    `Saved ${p}\nMode: ${cfg.mode} · keys: ${keyNames(cfg).join(", ") || "none"}\nNext: cortex doctor, then cortex start`,
    {
      ok: true,
      path: p,
      mode: cfg.mode,
      keys: keyNames(cfg),
    },
  );
}

async function start(home: string, cfg: LocalConfig, minutes?: number): Promise<void> {
  const c = new LocalCortex({ home, root: ROOT, cfg });
  await c.start();
  const link = await c.loginLink();
  out(
    `CORTEX-54 ${cfg.mode} mode running at ${c.url()}\nWeb terminal (single-use login, 10 min): ${link}\nStop with Ctrl+C.`,
    {
      ok: true,
      url: c.url(),
      login: link,
      mode: cfg.mode,
    },
  );
  const stop = async () => {
    await c.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  if (minutes) setTimeout(() => void stop(), minutes * 60_000);
  // Started by the desktop app: exit with it, even if it was killed rather than quit (no orphaned brain)
  const parent = Number(process.env.CORTEX_PARENT_PID ?? 0);
  if (parent > 0)
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        void stop();
      }
    }, 5_000).unref();
}

async function main(): Promise<void> {
  const home = cortexHome();
  const cmd = args[0] ?? "help";
  switch (cmd) {
    case "setup":
      return setup(home);
    case "doctor": {
      const checks = await doctor(home);
      const bad = checks.filter((x) => !x.ok);
      out(
        `${checks
          .map(
            (x) => `${x.ok ? "✅" : "❌"} ${x.name}: ${x.detail}${x.ok || !x.fix ? "" : `\n   → ${x.fix}`}`,
          )
          .join("\n")}\n${bad.length ? `${bad.length} thing(s) to fix.` : "All good."}`,
        { ok: bad.length === 0, checks },
      );
      process.exitCode = bad.length ? 1 : 0;
      return;
    }
    case "start": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: run `cortex setup` first (or `cortex demo`)");
      return start(home, cfg);
    }
    case "demo": {
      const tmp = mkdtempSync(join(tmpdir(), "cortex54-demo-"));
      const cfg = { ...newConfig("demo"), port: Number(opt("port") ?? 8755) };
      saveConfig(cfg, tmp);
      process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
      return start(tmp, cfg, Number(opt("minutes") ?? 0) || undefined);
    }
    case "link": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config");
      const { loginLink } = await import("../src/web/api.ts");
      const l = await loginLink(
        { WEB_SESSION_SECRET: cfg.secrets.web_session },
        `http://127.0.0.1:${cfg.port}`,
      );
      return out(l ?? "", { login: l });
    }
    case "service": {
      const sub = args[1] ?? "print";
      const argv = [process.execPath, "--import", "tsx", join(ROOT, "local", "cli.ts"), "start"];
      const p = plan(process.platform, argv, { CORTEX_HOME: home });
      if (sub === "install") {
        const steps = install(p);
        return out(steps.join("\n"), { ok: true, steps });
      }
      if (sub === "uninstall") {
        const steps = uninstall(p);
        return out(steps.join("\n"), { ok: true, steps });
      }
      return out(
        `${p.file ?? "(Task Scheduler)"}\n${p.content ?? p.enable.map((c) => c.join(" ")).join("\n")}`,
        p,
      );
    }
    case "kill": {
      writeFileSync(join(home, "KILLED"), `${new Date().toISOString()} ${args.slice(1).join(" ")}\n`);
      return out("Kill switch set: no new entries until `cortex rearm`. Positions keep their stops.", {
        ok: true,
        killed: true,
      });
    }
    case "rearm":
      rmSync(join(home, "KILLED"), { force: true });
      return out("Kill switch cleared.", { ok: true, killed: false });
    case "deploy": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: run `cortex setup` first");
      const name = opt("name") ?? cfg.cloud?.worker ?? "cortex";
      const r = deploy({
        root: ROOT,
        home,
        cfg,
        name,
        log: (s) => {
          if (!json) console.log(s);
        },
        run: (cmd, a, env) => {
          const p = spawnSync(cmd, a, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
          return { status: p.status ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
        },
      });
      saveConfig({ ...cfg, cloud: r.cloud }, home);
      return out(
        `Deployed ${name}: ${r.url}\nSentinel: ${r.sentinelUrl}\nResearch jobs wait for this machine: run \`cortex runner\` (or \`cortex service install\`).`,
        { ok: true, ...r, cloud: { url: r.cloud.url, worker: r.cloud.worker } },
      );
    }
    case "runner": {
      const cfg = loadConfig(home);
      if (!cfg?.cloud?.url) throw new Error("no cloud brain linked: run `cortex deploy` first");
      const cloud = cfg.cloud;
      const jobs = new LocalJobs({
        researchDir: join(ROOT, "research"),
        home,
        url: cloud.url,
        cfg: { ...cfg, secrets: { ...cfg.secrets, ingest_hmac: cloud.ingest_hmac } },
      });
      out(`Runner polling ${cloud.url} every 60 s (Ctrl+C to stop).`, { ok: true, url: cloud.url });
      const loop = async () => {
        try {
          const got = await claimOnce(cloud.url, cloud.ingest_hmac, jobs);
          if (got) console.log(`${new Date().toISOString()} running ${got}`);
        } catch (e) {
          console.error(`${new Date().toISOString()} ${String(e).slice(0, 200)}`);
        }
        setTimeout(() => void loop(), 60_000);
      };
      return loop();
    }
    case "keys": {
      const cfg = loadConfig(home);
      return out(cfg ? keyNames(cfg).join("\n") : "no config", { keys: cfg ? keyNames(cfg) : [] });
    }
    default:
      console.log(
        "cortex setup | doctor | start | demo | link | service install|uninstall|print | kill | rearm | keys   (--json for machine output)",
      );
  }
}

main().catch((e) => {
  out(`Error: ${String(e instanceof Error ? e.message : e)}`, {
    ok: false,
    error: String(e instanceof Error ? e.message : e),
  });
  process.exitCode = 1;
});
