import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDispatcher } from "../src/cortex/dispatch.ts";
import type { LocalConfig } from "./config.ts";

/**
 * Local job runner (ADR-064). The brain "dispatches" its batch workflows exactly as in the cloud (research, Kronos,
 * dossiers, Governor), but here each one is a local Python subprocess (`uv run …`) that posts its signed batch back
 * to this machine's /ingest/batch. No GitHub account, no Actions minutes, no cloud. Jobs that need a pinned upstream
 * checkout get it cloned once into the CORTEX home.
 */

const UPSTREAM = {
  repo: "tradermonty/claude-trading-skills",
  sha: "cb0f3aadffed6d1089db4b224162c964368baa46",
};
const KRONOS = { repo: "shiyu-coder/Kronos", sha: "67b630e67f6a18c9e9be918d9b4337c960db1e9a" };

export interface JobSpec {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  vendor?: "upstream" | "kronos";
  key: string;
}

/** Map a dispatch (workflow + inputs) to a local command. Pure; null for unknown jobs. */
export function jobFor(
  workflow: string,
  inputs: Record<string, string>,
  ctx: { researchDir: string; home: string; url: string; cfg: LocalConfig },
): JobSpec | null {
  const k = ctx.cfg.keys;
  const env: Record<string, string> = {
    CORTEX_URL: ctx.url,
    INGEST_HMAC_SECRET: ctx.cfg.secrets.ingest_hmac,
    ...(k.ALPACA_PAPER_KEY_ID
      ? { ALPACA_KEY_ID: k.ALPACA_PAPER_KEY_ID, ALPACA_SECRET: k.ALPACA_PAPER_SECRET ?? "" }
      : {}),
    ...Object.fromEntries(
      (
        [
          "GEMINI_API_KEY",
          "GROQ_API_KEY",
          "NVIDIA_API_KEY",
          "OPENROUTER_API_KEY",
          "SEC_USER_AGENT",
          "FMP_API_KEY",
          "FRED_API_KEY",
        ] as const
      )
        .filter((n) => k[n])
        .map((n) => [n, k[n] as string]),
    ),
    RUN_URL: "",
    // the Python env lives in the CORTEX home, never inside the (read-only, signed) app bundle
    UV_PROJECT_ENVIRONMENT: join(ctx.home, "venv"),
  };
  const uv = (extra: string[], groups: string[] = []) => [
    "run",
    "--directory",
    ctx.researchDir,
    ...groups.flatMap((g) => ["--group", g]),
    "python",
    "-m",
    ...extra,
  ];
  if (workflow === "governor.yml")
    return {
      cmd: "uv",
      args: uv(["cortex_research.governor.run", ...(inputs.weekly === "true" ? ["--weekly"] : [])]),
      env,
      key: `governor${inputs.weekly === "true" ? "-weekly" : ""}`,
    };
  if (workflow !== "research.yml") return null;
  const job = inputs.job ?? "";
  if (!["crypto", "equity", "world", "options", "screeners", "kronos", "backtest", "dossier"].includes(job))
    return null;
  const vendorDir = join(ctx.home, "vendor");
  if (job === "dossier")
    return {
      cmd: "uv",
      args: uv(["cortex_research.run", "dossier"]),
      env: {
        ...env,
        DOSSIER_SYMBOL: inputs.symbol ?? "",
        DOSSIER_CONTEXT: inputs.context ?? "",
        DOSSIER_ARENA: inputs.arena ?? "",
        DOSSIER_MODE: inputs.mode ?? "case",
        DOSSIER_DEPTH: inputs.depth ?? "standard",
        DOSSIER_CATALYST: inputs.catalyst ?? "",
        DOSSIER_KILL: inputs.kill ?? "",
      },
      key: `dossier-${inputs.symbol ?? "?"}`,
    };
  if (job === "kronos")
    return {
      cmd: "uv",
      args: uv(["cortex_research.run", "kronos"], ["kronos", "chronos"]),
      env: { ...env, KRONOS_DIR: join(vendorDir, "kronos"), KRONOS_SHA: KRONOS.sha },
      vendor: "kronos",
      key: "kronos",
    };
  if (job === "options") return { cmd: "uv", args: uv(["cortex_research.options.lab"]), env, key: "options" };
  const needsUpstream = job === "crypto" || job === "equity" || job === "screeners";
  return {
    cmd: "uv",
    args: uv(["cortex_research.run", job]),
    env: {
      ...env,
      ...(needsUpstream ? { UPSTREAM_DIR: join(vendorDir, "upstream"), UPSTREAM_SHA: UPSTREAM.sha } : {}),
    },
    ...(needsUpstream ? { vendor: "upstream" as const } : {}),
    key: job,
  };
}

export class LocalJobs implements WorkflowDispatcher {
  private readonly running = new Map<string, ChildProcess>();
  readonly log: { at: number; key: string; event: string }[] = [];

  constructor(
    private readonly ctx: { researchDir: string; home: string; url: string; cfg: LocalConfig },
    private readonly spawner: typeof spawn = spawn,
  ) {}

  /** Same contract as the GitHub dispatcher: returns once started; throws when it can't start. */
  async dispatch(workflow: string, inputs: Record<string, string>): Promise<void> {
    if (!this.ctx.cfg.research.enabled) throw new Error("local research is disabled in config");
    const spec = jobFor(workflow, inputs, this.ctx);
    if (!spec) throw new Error(`no local runner for ${workflow} ${inputs.job ?? ""}`);
    if (this.running.has(spec.key)) return; // already running: same as GitHub's per-job concurrency group
    if (this.running.size >= this.ctx.cfg.research.max_parallel) throw new Error("local job slots full");
    if (spec.vendor) this.ensureVendor(spec.vendor);
    const logs = join(this.ctx.home, "logs");
    mkdirSync(logs, { recursive: true });
    const out = createWriteStream(join(logs, `${spec.key.replace(/[^a-z0-9-]/gi, "_")}.log`), { flags: "a" });
    out.write(`\n=== ${new Date().toISOString()} ${spec.cmd} ${spec.args.join(" ")}\n`);
    const child = this.spawner(spec.cmd, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    this.running.set(spec.key, child);
    this.note(spec.key, "started");
    child.on("error", (e) => {
      this.running.delete(spec.key);
      this.note(spec.key, `error ${String(e).slice(0, 120)}`);
    });
    child.on("exit", (code) => {
      this.running.delete(spec.key);
      this.note(spec.key, `exit ${code}`);
    });
  }

  active(): string[] {
    return [...this.running.keys()];
  }

  private note(key: string, event: string): void {
    this.log.push({ at: Date.now(), key, event });
    if (this.log.length > 200) this.log.shift();
  }

  private ensureVendor(which: "upstream" | "kronos"): void {
    const v = which === "upstream" ? UPSTREAM : KRONOS;
    const dir = join(this.ctx.home, "vendor", which);
    if (existsSync(join(dir, ".git"))) return;
    mkdirSync(join(this.ctx.home, "vendor"), { recursive: true });
    const clone = spawnSync("git", ["clone", "--filter=blob:none", `https://github.com/${v.repo}`, dir], {
      stdio: "ignore",
    });
    if (clone.status !== 0) throw new Error(`could not clone ${v.repo} (is git installed?)`);
    spawnSync("git", ["-C", dir, "checkout", "--quiet", v.sha], { stdio: "ignore" });
  }
}
