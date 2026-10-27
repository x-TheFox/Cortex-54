import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AlpacaClient } from "../src/broker/AlpacaClient.ts";
import { type ApiFormat, listModels, normalizeUrl, PRESETS, presetForKey } from "../src/court/models.ts";
import { buildPool } from "../src/court/pool.ts";
import { buildProviders } from "../src/court/providers.ts";
import { CONSTITUTION_SHA256, DOCTRINE, SCAR_TISSUE } from "../src/generated/config.ts";
import { agentIdOf, canonical, generateAgentKey, publicKeyOf } from "../src/hub/protocol.ts";
import { backupFileName, homeFiles, makeBackup, openBackup, restoreInto, snapshotDb } from "./backup.ts";
import {
  applyKeys,
  configPath,
  cortexHome,
  type KEY_NAMES,
  keyNames,
  type LocalConfig,
  LocalConfigSchema,
  loadConfig,
  newConfig,
  saveConfig,
} from "./config.ts";
import { deploy, verifyDeploy } from "./deploy.ts";
import { type Check, configChecks } from "./health.ts";
import { LocalJobs } from "./jobs.ts";
import { accountFor, secretBackend } from "./keychain.ts";
import { activateKey, installLicense, readLicense, refreshLicense, releaseKey } from "./license.ts";
import { applyPack, exportPack, loadLocalScar, mergeScar, stagePack } from "./memory.ts";
import { claimOnce } from "./runner.ts";
import { clefNotice, LocalCortex, resolveClef } from "./runtime.ts";
import { install, plan, uninstall } from "./service.ts";
import { LocalSettings, mergeEndpoints } from "./settings.ts";
import { fileSql } from "./store.ts";

/**
 * `cortex` — the Savant command line (ADR-064). Every command has a plain-text and a `--json` form so a human or
 * an AI agent can drive setup end to end (docs/SETUP_WITH_AN_AGENT.md).
 *
 *   savant setup [--mode demo|paper] [--set KEY=VALUE ...] [--yes]   create or update ~/.cortex54/config.json
 *   savant doctor [--json]                                           check everything, say exactly what to fix
 *   savant start                                                     run the brain + web terminal (foreground)
 *   savant demo [--minutes N]                                        keyless demo in a throwaway home
 *   savant link                                                      one-time login link for the web terminal
 *   savant service install|uninstall|print                           run at login, restart on crash
 *   savant kill [reason] | savant rearm                              local kill switch (blocks all entries)
 *   savant keys                                                      list which key names are set (never values)
 *   savant deploy [--name cortex]                                    deploy brain + sentinel to YOUR Cloudflare account
 *   savant runner                                                    run the cloud brain's research jobs on this machine
 *   savant hub keygen [--name N] | hub id | hub follow <agent> | hub leaderboard     community hub (ADR-068)
 *   savant memory export [--title T] [--publish] | memory import <file|pack-id> | memory apply <id>
 *   savant backup [--keys] [--out FILE] | restore FILE                encrypted backup (passphrase from CORTEX_PASSPHRASE or a prompt)
 *   savant keychain on|off|status                                    keep keys in the system keychain instead of config.json
 *   savant reset --yes                                               stop the service and delete everything in the Savant home
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

async function portFree(port: number, bind: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, bind, () => s.close(() => res(true)));
  });
}

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
        fix: "Run `savant setup` to rewrite it.",
      });
      return undefined;
    }
  })();
  if (cfg === null)
    c.push({
      name: "config",
      ok: false,
      detail: `no config in ${home}`,
      fix: "Run `savant setup --mode demo --yes` (no keys needed) or `savant setup` for paper trading.",
    });
  c.push({
    name: "web app",
    ok: existsSync(join(ROOT, "public", "index.html")),
    detail: join(ROOT, "public"),
    fix: "Run `pnpm web:build`.",
  });
  if (cfg) {
    const free = await portFree(cfg.port, cfg.bind);
    // a busy port is fine when it's this Savant answering there
    const ours =
      !free &&
      (await fetch(`http://${cfg.bind === "0.0.0.0" ? "127.0.0.1" : cfg.bind}:${cfg.port}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
        .then(
          async (r) =>
            String(((await r.json()) as { name?: string }).name ?? "").match(/^(Savant|CORTEX-54)/) !== null,
        ) // an older app on this port counts too
        .catch(() => false));
    c.push({
      name: "port",
      ok: free || ours,
      detail: ours ? `${cfg.bind}:${cfg.port} (Savant is running there)` : `${cfg.bind}:${cfg.port}`,
      fix: "Another program uses this port; change `port` in config.json.",
    });
    c.push(...(await configChecks(cfg, home)));
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
  if (flag("onboarded")) cfg = { ...cfg, onboarded: true };
  if (!flag("yes") && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q: string, d = "") => (await rl.question(`${q}${d ? ` [${d}]` : ""}: `)).trim() || d;
    console.log(
      "Savant setup — press Enter to keep a value. Keys stay on this machine (config.json, mode 600).\n",
    );
    const m = await ask(
      "Mode: demo (no keys, simulated broker) or paper (your Alpaca paper account)",
      cfg.mode,
    );
    cfg = { ...cfg, mode: m === "paper" ? "paper" : "demo" };
    const prompts: [(typeof KEY_NAMES)[number], string][] = [
      ["ALPACA_PAPER_KEY_ID", "Alpaca PAPER key id (paper mode, also unlocks news + stocks)"],
      ["ALPACA_PAPER_SECRET", "Alpaca PAPER secret"],
      [
        "CLOUDFLARE_ACCOUNT_ID",
        "Cloudflare account id (recommended: real Clef + Clairic on free Workers AI)",
      ],
      ["CLOUDFLARE_API_TOKEN", "Cloudflare API token with Workers AI permission"],
      ["NTFY_TOPIC", "ntfy topic for phone alerts (optional, 16+ random chars)"],
    ];
    for (const [k, label] of prompts) {
      const v = await ask(`${label}${cfg.keys[k] ? " (set)" : ""}`);
      if (v) cfg = applyKeys(cfg, [`${k}=${v}`]);
    }
    if (!cfg.keys.CLOUDFLARE_ACCOUNT_ID || !cfg.keys.CLOUDFLARE_API_TOKEN)
      console.log(
        "\nNote: without Cloudflare AI, your own LLM stands in for Clef + Clairic. It works, but performance is marginally lower.\n",
      );
    cfg = await modelsPrompt(cfg, ask);
    rl.close();
  }
  const p = saveConfig(cfg, home);
  out(
    `Saved ${p}\nMode: ${cfg.mode} · keys: ${keyNames(cfg).join(", ") || "none"}\nNext: savant doctor, then savant start`,
    {
      ok: true,
      path: p,
      mode: cfg.mode,
      keys: keyNames(cfg),
    },
  );
}

async function start(home: string, first: LocalConfig, minutes?: number): Promise<void> {
  let cfg = first;
  let c: LocalCortex;
  let reloading = false;
  const settings = new LocalSettings({
    home,
    cfg: () => cfg,
    pool: () => c.pool,
    health: () => c.health(),
    clef: () => clefNotice(c.clefMode),
    spend: () => c.spend(),
    snapshot: () => c.snapshot(),
    pairLink: () => c.pairLink(),
    cashOnly: (acct) => c.makeCashOnly(acct),
    liveAccount: () => {
      const a = c.brain.status().accounts.find((x) => x.account === "LIVE" && x.configured);
      return a
        ? { mode: a.mode, reason: a.modeReason ?? null, equityUsd: a.equityUsd, autonomyStop: a.autonomyStop }
        : null;
    },
    account: () => {
      const a = c.brain.status().accounts.find((x) => x.account === "PAPER");
      return a
        ? { mode: a.mode, reason: a.modeReason ?? null, startUsd: a.startUsd, equityUsd: a.equityUsd }
        : null;
    },
    swap: async (write) => {
      reloading = true;
      try {
        await c.stop();
        write();
        cfg = loadConfig(home) ?? cfg;
        seen = JSON.stringify(cfg);
        c = new LocalCortex({ home, root: ROOT, cfg, settings });
        await c.start();
      } finally {
        reloading = false;
      }
    },
    wipe: async () => {
      reloading = true;
      unwatchFile(configPath(home));
      await c.stop().catch(() => undefined);
      wipeHome(home);
      console.log("[reset] Savant was reset on this computer.");
      process.exit(0);
    },
    // ADR-071: apply saved settings in-process (same port, same login session secret)
    reload: () => {
      if (reloading) return;
      reloading = true;
      void (async () => {
        try {
          await c.stop();
          cfg = loadConfig(home) ?? cfg;
          seen = JSON.stringify(cfg);
          c = new LocalCortex({ home, root: ROOT, cfg, settings });
          await c.start();
          console.log(`[settings] applied (${cfg.mode} mode)`);
        } catch (e) {
          console.error(`[settings] reload failed: ${String(e).slice(0, 300)}`);
        } finally {
          reloading = false;
        }
      })();
    },
  });
  c = new LocalCortex({ home, root: ROOT, cfg, settings });
  await c.start();
  // ADR-073: changes made outside the app (an agent running `savant llm add`, `savant setup --set …`) apply live
  let seen = JSON.stringify(cfg);
  watchFile(configPath(home), { interval: 1500 }, () => {
    try {
      const next = loadConfig(home);
      if (!next || JSON.stringify(next) === seen || reloading) return;
      seen = JSON.stringify(next);
      settings.reloadNow();
    } catch {
      /* half-written file: the next tick reads it whole */
    }
  });
  // ADR-086: keep a Whop licence fresh (daily; a lapsed purchase reaches the app within a day while online)
  const refresh = () =>
    void refreshLicense(home, cfg.keys.SAVANT_LICENSE_KEY)
      .then((r) => {
        if (r === "renewed" || r === "revoked") console.log(`[licence] ${r}`);
      })
      .catch(() => undefined);
  refresh();
  setInterval(refresh, 3 * 3_600_000).unref();
  const link = await c.loginLink();
  out(
    `Savant ${cfg.mode} mode running at ${c.url()}\nWeb app (single-use login, 10 min): ${link}\nStop with Ctrl+C.`,
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
            (x) =>
              `${x.ok ? (x.warn ? "⚠️ " : "✅") : "❌"} ${x.name}: ${x.detail}${(x.ok && !x.warn) || !x.fix ? "" : `\n   → ${x.fix}`}`,
          )
          .join("\n")}\n${bad.length ? `${bad.length} thing(s) to fix.` : "All good."}`,
        { ok: bad.length === 0, checks },
      );
      process.exitCode = bad.length ? 1 : 0;
      return;
    }
    case "start": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: run `savant setup` first (or `savant demo`)");
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
      // bundled (desktop/headless): node cortexd.mjs start; from source: node --import tsx local/cli.ts start
      const self = process.argv[1] ?? "";
      const argv = self.endsWith(".mjs")
        ? [process.execPath, self, "start"]
        : [process.execPath, "--import", "tsx", join(ROOT, "local", "cli.ts"), "start"];
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
      return out("Kill switch set: no new entries until `savant rearm`. Positions keep their stops.", {
        ok: true,
        killed: true,
      });
    }
    case "rearm":
      rmSync(join(home, "KILLED"), { force: true });
      return out("Kill switch cleared.", { ok: true, killed: false });
    case "deploy": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: run `savant setup` first");
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
      const runner = (cmd: string, a: string[], env: Record<string, string>) => {
        const p = spawnSync(cmd, a, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
        return { status: p.status ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
      };
      const v = r.url
        ? await verifyDeploy({ url: r.url, name, cfg, expectConstitution: CONSTITUTION_SHA256, run: runner })
        : { healthy: false, rolledBack: false, detail: "no URL in the deploy output" };
      if (!v.healthy) process.exitCode = 1;
      return out(
        `${v.healthy ? "Deployed" : "Deploy FAILED its health check"} ${name}: ${r.url}\n${v.detail}\nSentinel: ${r.sentinelUrl}\nResearch jobs wait for this machine: run \`savant runner\` (or \`savant service install\`).`,
        { ok: v.healthy, ...r, verify: v, cloud: { url: r.cloud.url, worker: r.cloud.worker } },
      );
    }
    case "runner": {
      const cfg = loadConfig(home);
      if (!cfg?.cloud?.url) throw new Error("no cloud brain linked: run `savant deploy` first");
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
    case "hub": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config");
      const sub = args[1];
      if (sub === "keygen") {
        if (cfg.keys.HUB_AGENT_KEY && !flag("force"))
          throw new Error("this agent already has a key (--force replaces it and starts a new identity)");
        const k = await generateAgentKey();
        const next = applyKeys(cfg, [
          `HUB_AGENT_KEY=${k.privateKey}`,
          ...(opt("name") ? [`HUB_AGENT_NAME=${opt("name")}`] : []),
        ]);
        saveConfig(next, home);
        return out(
          `Agent id ${k.agentId} (key saved in config.json; back it up: it is this agent's identity)`,
          { ok: true, agent_id: k.agentId },
        );
      }
      if (!cfg.keys.HUB_AGENT_KEY) throw new Error("no agent key: run `savant hub keygen` first");
      const id = agentIdOf(await publicKeyOf(cfg.keys.HUB_AGENT_KEY));
      if (sub === "id") return out(id, { agent_id: id });
      if (sub === "follow") {
        const a = args[2] ?? "";
        if (!/^[0-9a-f]{16}$/.test(a)) throw new Error("give a 16-hex agent id");
        const list = [...new Set([...(cfg.keys.HUB_FOLLOW ?? "").split(",").filter(Boolean), a])];
        saveConfig(applyKeys(cfg, [`HUB_FOLLOW=${list.join(",")}`]), home);
        return out(`Following ${list.join(", ")} (restart cortex to apply)`, { ok: true, follow: list });
      }
      if (sub === "leaderboard") {
        const url = cfg.keys.HUB_URL;
        if (!url) throw new Error("set HUB_URL first");
        const lb = await (await fetch(`${url.replace(/\/$/, "")}/v1/leaderboard`)).json();
        return out(JSON.stringify(lb, null, 2), lb);
      }
      throw new Error("savant hub keygen | id | follow <agent> | leaderboard");
    }
    case "memory": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config");
      const sub = args[1];
      if (sub === "export") {
        if (!cfg.keys.HUB_AGENT_KEY) throw new Error("no agent key: run `savant hub keygen` first");
        const sql = fileSql(join(home, "hot.sqlite"));
        const pack = await exportPack(
          sql,
          mergeScar(SCAR_TISSUE, loadLocalScar(home)),
          cfg.keys.HUB_AGENT_KEY,
          opt("title") ?? "Savant memory",
          opt("description") ?? "",
          Date.now(),
        );
        const file = opt("out") ?? join(home, `memory-${Date.now()}.cortexpack.json`);
        writeFileSync(file, canonical(pack));
        let published: unknown = null;
        if (flag("publish")) {
          if (!cfg.keys.HUB_URL) throw new Error("set HUB_URL to publish");
          const r = await fetch(`${cfg.keys.HUB_URL.replace(/\/$/, "")}/v1/packs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: canonical(pack),
          });
          published = await r.json();
        }
        return out(`Wrote ${file}${published ? `\nPublished: ${JSON.stringify(published)}` : ""}`, {
          ok: true,
          file,
          published,
        });
      }
      if (sub === "import") {
        const src = args[2] ?? "";
        let raw: unknown;
        if (/^[0-9a-f]{16}$/.test(src)) {
          if (!cfg.keys.HUB_URL) throw new Error("set HUB_URL to import from the hub");
          raw = await (await fetch(`${cfg.keys.HUB_URL.replace(/\/$/, "")}/v1/packs/${src}`)).json();
        } else raw = JSON.parse((await import("node:fs")).readFileSync(src, "utf8"));
        const st = await stagePack(home, raw);
        return out(
          `Staged pack ${st.id} from agent ${st.author}: ${st.rules} scar rule(s), ${st.beliefs} belief(s).\nNothing changed yet. Review ${join(home, "proposals", `${st.id}.json`)}, then: savant memory apply ${st.id}`,
          { ok: true, ...st },
        );
      }
      if (sub === "apply") {
        const sql = fileSql(join(home, "hot.sqlite"));
        const r = applyPack(home, sql, args[2] ?? "", Date.now());
        return out(
          `Applied: ${r.rules} scar rule(s) (they only ever remove trades), ${r.beliefs} belief(s) at half confidence. Restart cortex to load the rules.`,
          { ok: true, ...r },
        );
      }
      throw new Error("savant memory export | import <file|pack-id> | apply <id>");
    }
    case "support": {
      // ADR-073: a redacted diagnostics file to send for help (no keys, no secrets)
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: run `savant setup` first");
      const built = buildPool(DOCTRINE, buildProviders(cfg.keys), cfg.llm);
      const s = new LocalSettings({
        home,
        cfg: () => cfg,
        reload: () => undefined,
        pool: () => built.report,
        clef: () => clefNotice(resolveClef(cfg, built).label),
      });
      const file = join(home, `support-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
      writeFileSync(file, `${JSON.stringify(await s.support(), null, 2)}\n`, { mode: 0o600 });
      return out(`Support file written (no keys or secrets in it): ${file}`, { ok: true, path: file });
    }
    case "llm": {
      // ADR-072: the model pool from the command line (what an agent uses to set things up)
      let cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: run `savant setup --mode demo --yes` first");
      const sub = args[1] ?? "list";
      const report = () =>
        buildPool(DOCTRINE, buildProviders(cfg?.keys ?? {}), cfg?.llm ?? newConfig().llm).report;
      if (sub === "list")
        return out(
          `${report()
            .entries.map((e) => `${e.tier.padEnd(5)} ${e.source} · ${e.model} (${e.family})`)
            .join("\n")}\n${report()
            .notes.map((n) => n.text)
            .join(" ")}`,
          {
            endpoints: cfg.llm.endpoints.map((e) => ({ ...e, key: e.key ? "set" : "" })),
            prefs: cfg.llm.prefs,
            pool: report(),
          },
        );
      if (sub === "add") {
        const input = args[2];
        if (!input)
          throw new Error(
            "savant llm add <key-or-url> [--url U] [--format openai|anthropic] [--models a,b] [--tier free|paid|local] [--name N]",
          );
        const ask = async (q: string, d = "") => {
          if (!process.stdin.isTTY) throw new Error(`${q}: pass it as a flag (non-interactive)`);
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const a = (await rl.question(`${q}${d ? ` [${d}]` : ""}: `)).trim() || d;
          rl.close();
          return a;
        };
        const r = await addFromInput(cfg, input, ask, {
          ...(opt("format") ? { format: opt("format") as string } : {}),
          ...(opt("url") ? { url: opt("url") as string } : {}),
          ...(opt("models") ? { models: opt("models") as string } : {}),
          ...(opt("tier") ? { tier: opt("tier") as string } : {}),
          ...(opt("name") ? { name: opt("name") as string } : {}),
        });
        cfg = r.cfg;
        saveConfig(cfg, home);
        return out(
          `${r.message}\n${report()
            .notes.map((n) => n.text)
            .join(" ")}`,
          { ok: true, message: r.message, pool: report() },
        );
      }
      if (sub === "remove") {
        const id = args[2];
        const endpoints = cfg.llm.endpoints.filter((e) => e.id !== id);
        if (endpoints.length === cfg.llm.endpoints.length)
          throw new Error(`no endpoint ${id} (savant llm list --json shows ids)`);
        saveConfig({ ...cfg, llm: { ...cfg.llm, endpoints } }, home);
        return out(`Removed ${id}.`, { ok: true });
      }
      if (sub === "models") {
        const e = cfg.llm.endpoints.find((x) => x.id === args[2]);
        const r = e
          ? await listModels(e.format, e.url, e.key)
          : await listModels((opt("format") as ApiFormat) ?? "openai", args[2], opt("key") ?? "");
        return out(r.ok ? r.models.join("\n") : `Could not list: ${r.error}`, r);
      }
      if (sub === "prefs") {
        const prefs = {
          ...cfg.llm.prefs,
          ...(opt("prefer") ? { prefer: opt("prefer") } : {}),
          ...(opt("round-robin") ? { round_robin: opt("round-robin") !== "off" } : {}),
          ...(opt("same-model") ? { allow_same_model: opt("same-model") === "yes" } : {}),
        };
        const next = LocalConfigSchema.parse({ ...cfg, llm: { ...cfg.llm, prefs } });
        saveConfig(next, home);
        return out(
          `prefer ${next.llm.prefs.prefer} · round robin ${next.llm.prefs.round_robin ? "on" : "off"} · same model ${next.llm.prefs.allow_same_model ? "allowed" : "not allowed"}`,
          { ok: true, prefs: next.llm.prefs },
        );
      }
      throw new Error(
        "savant llm list | add <key-or-url> | remove <id> | models <id-or-url> | prefs [--prefer free_first|paid_first|mixed] [--round-robin on|off] [--same-model yes|no]",
      );
    }
    case "backup": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config: nothing to back up");
      const pass = await passphrase("Passphrase for the backup (8+ characters)");
      const files: Record<string, Buffer> = {};
      for (const f of homeFiles(home)) {
        if (f.endsWith(".sqlite")) {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(join(home, f), { readOnly: true });
          files[f] = snapshotDb(db);
          db.close();
        } else files[f] = readFileSync(join(home, f));
      }
      const file = opt("out") ?? join(process.cwd(), backupFileName());
      writeFileSync(file, makeBackup({ cfg, includeKeys: flag("keys"), passphrase: pass, files }), {
        mode: 0o600,
      });
      return out(
        `Backup written: ${file}${flag("keys") ? " (includes your keys)" : " (no keys; add --keys to include them)"}`,
        { ok: true, file, with_keys: flag("keys") },
      );
    }
    case "restore": {
      const src = args[1];
      if (!src) throw new Error("savant restore <backup-file>");
      const b = openBackup(readFileSync(src, "utf8"), await passphrase("Passphrase"));
      if (await running(home)) throw new Error("Savant is running: quit the app (or stop the service) first");
      const next = restoreInto(home, b, loadConfig(home));
      saveConfig(next, home);
      return out(`Restored the backup from ${b.madeAt} into ${home} (${next.mode} mode).`, {
        ok: true,
        made_at: b.madeAt,
        mode: next.mode,
        with_keys: b.withKeys,
      });
    }
    case "license": {
      const sub = args[1] ?? "status";
      if (sub === "activate") {
        // ADR-086: the licence key from the Whop order
        const key = args[2];
        if (!key) throw new Error("savant license activate <licence-key>");
        const r = await activateKey(home, key, { app: "cli" });
        if (r.ok) {
          const cfg = loadConfig(home);
          if (cfg) saveConfig(applyKeys(cfg, [`SAVANT_LICENSE_KEY=${key.trim()}`]), home);
        }
        if (!r.ok) process.exitCode = 1;
        return out(r.message, r);
      }
      if (sub === "release") {
        const cfg = loadConfig(home);
        const key = cfg?.keys.SAVANT_LICENSE_KEY;
        if (!key) throw new Error("no licence key saved on this computer");
        const r = await releaseKey(home, key);
        if (r.ok && cfg) saveConfig(applyKeys(cfg, ["SAVANT_LICENSE_KEY="]), home);
        return out(r.message, r);
      }
      if (sub === "install") {
        const st = installLicense(home, readFileSync(args[2] ?? "", "utf8"));
        return out(
          st.required && st.ok
            ? `Licence installed for ${st.license.licensee} (${st.license.plan}).`
            : "This build doesn't check licences.",
          { ok: true, license: st },
        );
      }
      const st = readLicense(home);
      return out(
        !st.required
          ? "This build doesn't check licences."
          : st.ok
            ? `Licensed to ${st.license.licensee} (${st.license.plan})${st.daysLeft === null ? "" : `, ${st.daysLeft} days left`}.`
            : `No valid licence: ${st.reason}`,
        st,
      );
    }
    case "keychain": {
      const cfg = loadConfig(home);
      if (!cfg) throw new Error("no config");
      const sub = args[1] ?? "status";
      const b = secretBackend(home);
      if (sub === "status")
        return out(
          `Keys are kept in: ${cfg.secret_store === "keychain" ? b.name : "config.json (mode 600)"}`,
          {
            secret_store: cfg.secret_store,
            backend: b.available() ? b.name : null,
          },
        );
      if (sub === "on") {
        if (!b.available()) throw new Error("no system keychain found on this computer");
        saveConfig({ ...cfg, secret_store: "keychain" }, home);
        return out(`Keys moved to ${b.name}; config.json no longer holds them.`, { ok: true });
      }
      if (sub === "off") {
        saveConfig({ ...cfg, secret_store: "file" }, home);
        return out("Keys moved back to config.json (mode 600).", { ok: true });
      }
      throw new Error("savant keychain on | off | status");
    }
    case "reset": {
      if (!flag("yes"))
        throw new Error("this deletes every setting, key and journal in the Savant home: add --yes");
      if (await running(home))
        throw new Error("Savant is running: quit the app first (or use Settings → Reset)");
      const self = process.argv[1] ?? "";
      const argv = self.endsWith(".mjs")
        ? [process.execPath, self, "start"]
        : [process.execPath, "--import", "tsx", join(ROOT, "local", "cli.ts"), "start"];
      try {
        uninstall(plan(process.platform, argv, { CORTEX_HOME: home }));
      } catch {
        /* no service installed */
      }
      wipeHome(home);
      return out(`Reset: ${home} deleted.`, { ok: true });
    }
    case "keys": {
      const cfg = loadConfig(home);
      return out(cfg ? keyNames(cfg).join("\n") : "no config", { keys: cfg ? keyNames(cfg) : [] });
    }
    default:
      console.log(
        "savant setup | doctor | start | demo | link | support | llm list|add|remove|models|prefs | backup | restore | keychain | reset | service install|uninstall|print | kill | rearm | keys   (--json for machine output)",
      );
  }
}

/** Delete the Savant home and its keychain item (reset). Refuses anything that isn't a Savant home. */
function wipeHome(home: string): void {
  if (!existsSync(configPath(home)) && !existsSync(join(home, "hot.sqlite")))
    throw new Error(`${home} doesn't look like a Savant home`);
  try {
    secretBackend(home).del(accountFor(home));
  } catch {
    /* no keychain item */
  }
  rmSync(home, { recursive: true, force: true });
}

async function running(home: string): Promise<boolean> {
  const cfg = loadConfig(home);
  if (!cfg) return false;
  return fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(2_000) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function passphrase(q: string): Promise<string> {
  if (process.env.CORTEX_PASSPHRASE) return process.env.CORTEX_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Error("set CORTEX_PASSPHRASE (non-interactive)");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q}: `)).trim();
  rl.close();
  return a;
}

main().catch((e) => {
  out(`Error: ${String(e instanceof Error ? e.message : e)}`, {
    ok: false,
    error: String(e instanceof Error ? e.message : e),
  });
  process.exitCode = 1;
});

/**
 * Interactive models (ADR-072): paste any key or a local URL; known keys are recognized (Gemini, Groq, NIM go to the
 * built-in providers with their verified models), anything else becomes an endpoint with its models discovered.
 */
async function modelsPrompt(
  cfg: LocalConfig,
  ask: (q: string, d?: string) => Promise<string>,
): Promise<LocalConfig> {
  console.log(
    "\nAI models for the court. Paste API keys one at a time (free: aistudio.google.com/apikey, console.groq.com/keys),\nor a local address like http://127.0.0.1:11434/v1 (Ollama). Blank line when done.",
  );
  for (;;) {
    const report = buildPool(DOCTRINE, buildProviders(cfg.keys), cfg.llm).report;
    console.log(`  Now: ${report.notes.map((n) => n.text).join(" ")}`);
    const v = await ask("Key or URL");
    if (!v) break;
    const r = await addFromInput(cfg, v, ask);
    cfg = r.cfg;
    console.log(`  ${r.message}`);
  }
  return cfg;
}

/** One key or URL → a built-in key or a new endpoint (shared by setup and `savant llm add`). */
async function addFromInput(
  cfg: LocalConfig,
  input: string,
  ask: (q: string, d?: string) => Promise<string>,
  o: { format?: string; url?: string; models?: string; tier?: string; name?: string } = {},
): Promise<{ cfg: LocalConfig; message: string }> {
  const isUrl = /^https?:\/\//.test(input);
  const preset = isUrl
    ? (PRESETS.find((p) => p.url && input.startsWith(p.url.replace(/\/v1$/, ""))) ?? null)
    : presetForKey(input);
  if (preset?.builtinKey && !isUrl && !o.url) {
    cfg = applyKeys(cfg, [`${preset.builtinKey}=${input}`]);
    return { cfg, message: `${preset.name}: key saved (uses its verified free models).` };
  }
  // a URL (or an unrecognized key) is OpenAI-compatible unless told otherwise: that is what almost every server speaks,
  // and an agent running this can't answer prompts
  const format: ApiFormat = (o.format ?? preset?.format ?? "openai") === "anthropic" ? "anthropic" : "openai";
  const url = normalizeUrl(
    format,
    o.url ?? (isUrl ? input : preset?.url || (await ask("Base URL", normalizeUrl(format, "")))),
  );
  const key = isUrl ? (o.url ? input : "") : input;
  const listed = await listModels(format, url, key);
  let models: string[] = [];
  if (o.models)
    models = o.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  else if (listed.ok && listed.models.length) {
    const shown = listed.models.slice(0, 60);
    for (const [i, m] of shown.entries()) console.log(`    ${String(i + 1).padStart(2)}. ${m}`);
    if (listed.models.length > shown.length)
      console.log(`    … and ${listed.models.length - shown.length} more (type a name)`);
    const pick = await ask("Models to use (numbers or names, comma-separated)", "1");
    models = pick
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (/^\d+$/.test(x) ? (shown[Number(x) - 1] ?? "") : x))
      .filter(Boolean);
  } else {
    console.log(`    Could not list models here (${listed.ok ? "empty list" : listed.error}).`);
    models = (await ask("Model name(s) exactly as the endpoint expects (comma-separated)"))
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  }
  if (!models.length) return { cfg, message: "No model chosen; nothing added." };
  const llm = cfg.llm;
  const endpoints = mergeEndpoints(llm.endpoints, [
    ...llm.endpoints,
    {
      name: o.name ?? preset?.name ?? new URL(listed.url).host,
      format,
      url: listed.url,
      key,
      models,
      tier: o.tier ?? preset?.tier ?? "paid",
    },
  ]);
  return {
    cfg: { ...cfg, llm: { ...llm, endpoints } },
    message: `Added ${models.length} model(s) from ${new URL(listed.url).host}.`,
  };
}
