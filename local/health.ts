import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AlpacaClient } from "../src/broker/AlpacaClient.ts";
import { buildPool } from "../src/court/pool.ts";
import { buildProviders } from "../src/court/providers.ts";
import { DOCTRINE } from "../src/generated/config.ts";
import type { LocalConfig } from "./config.ts";
import { clefNotice, resolveClef } from "./runtime.ts";

/**
 * Health checks in plain words (ADR-073): shared by `cortex doctor` and the app's SETTINGS → HEALTH block, so the
 * terminal and the app always agree. `ok: false` needs fixing; `warn` works but below full strength.
 */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  warn?: boolean;
}

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

export async function configChecks(
  cfg: LocalConfig,
  home: string,
  fetcher?: (u: string, i?: RequestInit) => Promise<Response>,
): Promise<Check[]> {
  const c: Check[] = [];
  const k = cfg.keys;
  c.push({
    name: "Trading account",
    ok: true,
    detail: cfg.mode === "paper" ? "your Alpaca paper account" : "demo (simulated $54 on live crypto prices)",
  });
  if (cfg.mode === "paper") {
    if (!k.ALPACA_PAPER_KEY_ID || !k.ALPACA_PAPER_SECRET)
      c.push({
        name: "Alpaca paper keys",
        ok: false,
        detail: "missing",
        fix: "Settings → Trading account, or `cortex setup --set ALPACA_PAPER_KEY_ID=… --set ALPACA_PAPER_SECRET=…`.",
      });
    else
      try {
        const a = await new AlpacaClient(
          "https://paper-api.alpaca.markets",
          { keyId: k.ALPACA_PAPER_KEY_ID, secret: k.ALPACA_PAPER_SECRET },
          () => undefined,
          fetcher,
        ).account();
        c.push({
          name: "Alpaca paper keys",
          ok: a.status === "ACTIVE",
          detail: `account ${a.status}, equity $${a.equity}`,
        });
      } catch (e) {
        c.push({
          name: "Alpaca paper keys",
          ok: false,
          detail: String(e).slice(0, 160),
          fix: "Check the keys (paper, not live) in the Alpaca dashboard.",
        });
      }
  }
  const built = buildPool(DOCTRINE, buildProviders(k), cfg.llm);
  c.push({
    name: "AI models (the court)",
    ok: !built.report.notes.some((n) => n.level === "block"),
    ...(built.report.notes.some((n) => n.level === "warn") ? { warn: true } : {}),
    detail: built.report.notes.map((n) => n.text).join(" "),
    fix: "Settings → AI models, or `cortex llm add <key>`. Free keys: Google AI Studio and Groq.",
  });
  const clef = clefNotice(resolveClef(cfg, built).label);
  c.push({
    name: "News triage and fact reading (Clef + Clairic)",
    ok: clef.ok,
    detail: clef.text,
    fix: "Settings → Cloudflare AI (free daily allowance).",
    ...(clef.level === "degraded" ? { warn: true } : {}),
  });
  const uv = has("uv");
  c.push({
    name: "Research tools (uv)",
    ok: uv || !cfg.research.enabled,
    detail: uv
      ? "found"
      : cfg.research.enabled
        ? "missing: research, forecasts and the weekly review can't run"
        : "research is off",
    fix: "Install uv (https://docs.astral.sh/uv/). The app's installer does this for you.",
  });
  c.push({
    name: "git (pinned research skills)",
    ok: has("git") || !cfg.research.enabled,
    detail: has("git") ? "found" : "missing",
    fix: "Install git.",
  });
  const killed = existsSync(join(home, "KILLED"));
  c.push({
    name: "Kill switch",
    ok: !killed,
    detail: killed ? "ON: the robot is flattened and stopped" : "off",
    fix: "Re-arm from the tray, or `cortex rearm`, when you mean it.",
  });
  return c;
}

/** Checks only a running brain can answer: pulse, research jobs, invariants. */
export function runtimeChecks(h: {
  now: number;
  last_pulse_at: number | null;
  policy_violations?: unknown[] | Record<string, unknown>;
  jobs?: { running: string[]; recent: { at: number; key: string; event: string }[] };
}): Check[] {
  const c: Check[] = [];
  const age = h.last_pulse_at === null ? null : h.now - h.last_pulse_at;
  c.push({
    name: "Heartbeat",
    ok: age !== null && age < 8 * 60_000,
    detail: age === null ? "no pulse yet" : `last pulse ${Math.round(age / 1000)} s ago`,
    fix: "Restart the app. If it keeps happening, send a support file.",
  });
  const ended = (h.jobs?.recent ?? []).filter((j) => /^(exit|error)/.test(j.event));
  const failed = ended.filter((j) => j.event !== "exit 0");
  c.push({
    name: "Research jobs",
    ok: ended.length < 3 || failed.length < ended.length,
    ...(failed.length > 0 ? { warn: true } : {}),
    detail: `${h.jobs?.running.length ?? 0} running · ${ended.length - failed.length} of the last ${ended.length} finished cleanly`,
    fix: "Check `uv` is installed and your AI keys work (Settings → AI models → test).",
  });
  // the brain reports violations as a map (rule → detail); older shapes were arrays
  const pv = h.policy_violations ?? {};
  const n = Array.isArray(pv) ? pv.length : Object.keys(pv).length;
  c.push({
    name: "Safety invariants",
    ok: n === 0,
    detail: n ? JSON.stringify(pv).slice(0, 200) : "all hold",
    fix: "The robot fails closed on its own; send a support file.",
  });
  return c;
}
