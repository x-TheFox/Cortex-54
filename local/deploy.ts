import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalConfig } from "./config.ts";

/**
 * `cortex deploy` (ADR-065): put the whole CORTEX-54 stack into the user's OWN Cloudflare account with one command:
 * D1 journals, the kill-flag KV, the brain worker (+ LAB brain), the sentinel watchdog, migrations and secrets. Needs
 * CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the local config (token permissions: Workers Scripts, D1, KV,
 * Workers AI: edit). Idempotent: reruns reuse what exists. Research jobs then run on the user's desktop runner
 * (RUNNER_MODE=queue), so no GitHub is involved. Every external call goes through the injected `run`, so the whole
 * flow is testable offline.
 */

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], env: Record<string, string>) => RunResult;

export interface DeployOptions {
  root: string;
  home: string;
  cfg: LocalConfig;
  /** worker name prefix, e.g. "cortex" → cortex, cortex-sentinel, cortex-journal… */
  name: string;
  run: Runner;
  log?: (s: string) => void;
}

export interface DeployResult {
  url: string | null;
  sentinelUrl: string | null;
  d1: { journal: string; lab: string };
  kv: string;
  steps: string[];
  cloud: NonNullable<LocalConfig["cloud"]>;
}

/** JSONC to JSON: drop line and block comments outside strings, then trailing commas. */
export function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i++;
      } else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
const strip = stripJsonc;

export function brainConfig(
  tpl: string,
  o: { name: string; journal: string; lab: string; kv: string; channels?: string | undefined; root?: string },
): string {
  const c = JSON.parse(strip(tpl)) as Record<string, unknown> & {
    d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
    kv_namespaces: { binding: string; id: string }[];
    vars: Record<string, string>;
  };
  const at = (p: string) => (o.root ? join(o.root, p) : p);
  c.name = o.name;
  c.main = at("src/index.ts");
  c.d1_databases = [
    {
      binding: "DB",
      database_name: `${o.name}-journal`,
      database_id: o.journal,
      migrations_dir: at("migrations"),
    },
    {
      binding: "DB_LAB",
      database_name: `${o.name}-lab`,
      database_id: o.lab,
      migrations_dir: at("migrations"),
    },
  ];
  c.assets = { directory: at("public"), binding: "ASSETS" };
  c.kv_namespaces = [{ binding: "FLAGS", id: o.kv }];
  const vars: Record<string, string> = {
    CORTEX_ENV: "production",
    CORTEX_DO_NAME: "CORTEX-54-PRIMARY",
    CORTEX_LAB_DO_NAME: "CORTEX-54-LAB",
    RUNNER_MODE: "queue",
  };
  if (o.channels) vars.DISCORD_CHANNELS = o.channels;
  c.vars = vars;
  delete (c as { $schema?: string }).$schema;
  return JSON.stringify(c, null, 2);
}

export function sentinelConfig(
  tpl: string,
  o: { name: string; kv: string; healthUrl: string; root?: string },
): string {
  const c = JSON.parse(strip(tpl)) as Record<string, unknown> & {
    kv_namespaces: unknown[];
    vars: Record<string, string>;
  };
  c.name = `${o.name}-sentinel`;
  c.main = o.root ? join(o.root, "workers", "sentinel", "src", "index.ts") : "src/index.ts";
  c.kv_namespaces = [{ binding: "FLAGS", id: o.kv }];
  c.vars = { ...c.vars, CORTEX_HEALTH_URL: o.healthUrl };
  delete (c as { $schema?: string }).$schema;
  return JSON.stringify(c, null, 2);
}

/** The worker's secrets from the local config: keys the user gave plus the shared HMAC/web/pill secrets. */
export function brainSecrets(cfg: LocalConfig, ingest: string): Record<string, string> {
  const k = cfg.keys;
  const pick = (n: keyof LocalConfig["keys"]) => (k[n] ? { [n]: k[n] as string } : {});
  return {
    ...pick("ALPACA_PAPER_KEY_ID"),
    ...pick("ALPACA_PAPER_SECRET"),
    ...pick("GEMINI_API_KEY"),
    ...pick("GROQ_API_KEY"),
    ...pick("NVIDIA_API_KEY"),
    ...pick("OPENROUTER_API_KEY"),
    ...pick("ANTHROPIC_API_KEY"),
    ...pick("OPENAI_API_KEY"),
    ...pick("OPENAI_MODEL"),
    ...pick("CUSTOM_LLM_BASE_URL"),
    ...pick("CUSTOM_LLM_API_KEY"),
    ...pick("CUSTOM_LLM_MODEL"),
    ...pick("DISCORD_BOT_TOKEN"),
    ...pick("NTFY_TOPIC"),
    ...pick("NTFY_URL"),
    INGEST_HMAC_SECRET: ingest,
    WEB_SESSION_SECRET: cfg.secrets.web_session,
    PILL_TOKEN: cfg.secrets.pill_token,
  };
}

const workersUrl = (out: string) => /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out)?.[0] ?? null;

export function deploy(o: DeployOptions): DeployResult {
  const k = o.cfg.keys;
  if (!k.CLOUDFLARE_ACCOUNT_ID || !k.CLOUDFLARE_API_TOKEN)
    throw new Error(
      "cloud deploy needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (cortex setup --set …)",
    );
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(o.name))
    throw new Error("name must be lowercase letters, digits and dashes");
  const env = {
    CLOUDFLARE_ACCOUNT_ID: k.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: k.CLOUDFLARE_API_TOKEN,
  };
  const steps: string[] = [];
  const log = o.log ?? (() => undefined);
  const w = (args: string[], what: string): RunResult => {
    const r = o.run("pnpm", ["-s", "wrangler", ...args], env);
    steps.push(`${what}: ${r.status === 0 ? "ok" : `exit ${r.status}`}`);
    log(`${r.status === 0 ? "✓" : "✗"} ${what}`);
    if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
    return r;
  };

  // 1. D1 journals (reuse when they exist)
  const listD1 = () =>
    JSON.parse(w(["d1", "list", "--json"], "list D1 databases").stdout || "[]") as {
      name: string;
      uuid: string;
    }[];
  let dbs = listD1();
  for (const db of [`${o.name}-journal`, `${o.name}-lab`])
    if (!dbs.some((d) => d.name === db)) {
      w(["d1", "create", db], `create D1 ${db}`);
      dbs = listD1();
    }
  const journal = dbs.find((d) => d.name === `${o.name}-journal`)?.uuid;
  const lab = dbs.find((d) => d.name === `${o.name}-lab`)?.uuid;
  if (!journal || !lab) throw new Error("D1 databases not found after create");

  // 2. KV for the kill flag
  const kvTitle = `${o.name}-FLAGS`;
  const listKv = () =>
    JSON.parse(w(["kv", "namespace", "list"], "list KV namespaces").stdout || "[]") as {
      id: string;
      title: string;
    }[];
  let kvs = listKv();
  if (!kvs.some((x) => x.title === kvTitle || x.title.endsWith(kvTitle))) {
    w(["kv", "namespace", "create", kvTitle], `create KV ${kvTitle}`);
    kvs = listKv();
  }
  const kv = kvs.find((x) => x.title === kvTitle || x.title.endsWith(kvTitle))?.id;
  if (!kv) throw new Error("KV namespace not found after create");

  // 3. generated configs (never the repo's own wrangler.jsonc)
  const dir = join(o.home, "deploy");
  mkdirSync(dir, { recursive: true });
  const brainPath = join(dir, `${o.name}.wrangler.json`);
  writeFileSync(
    brainPath,
    brainConfig(readFileSync(join(o.root, "wrangler.jsonc"), "utf8"), {
      name: o.name,
      journal,
      lab,
      kv,
      channels: k.DISCORD_CHANNELS,
      root: o.root,
    }),
  );

  // 4. schema, then the brain
  w(["d1", "migrations", "apply", `${o.name}-journal`, "--remote", "-c", brainPath], "migrate journal");
  w(["d1", "migrations", "apply", `${o.name}-lab`, "--remote", "-c", brainPath], "migrate LAB journal");
  const dep = w(["deploy", "-c", brainPath], "deploy brain");
  const url = workersUrl(dep.stdout);

  // 5. secrets (temp file, 0600, removed right after)
  const ingest = o.cfg.cloud?.ingest_hmac ?? randomBytes(24).toString("hex");
  const secretsFile = join(dir, "secrets.json");
  writeFileSync(secretsFile, JSON.stringify(brainSecrets(o.cfg, ingest)), { mode: 0o600 });
  try {
    w(["secret", "bulk", secretsFile, "-c", brainPath], "brain secrets");
  } finally {
    rmSync(secretsFile, { force: true });
  }

  // 6. the independent watchdog
  let sentinelUrl: string | null = null;
  if (url) {
    const sentPath = join(dir, `${o.name}-sentinel.wrangler.json`);
    writeFileSync(
      sentPath,
      sentinelConfig(readFileSync(join(o.root, "workers", "sentinel", "wrangler.jsonc"), "utf8"), {
        name: o.name,
        kv,
        healthUrl: `${url}/health`,
        root: o.root,
      }),
    );
    sentinelUrl = workersUrl(w(["deploy", "-c", sentPath], "deploy sentinel").stdout);
    const tick = randomBytes(24).toString("hex");
    const sentFile = join(dir, "sentinel-secrets.json");
    writeFileSync(
      sentFile,
      JSON.stringify({
        SENTINEL_TICK_SECRET: tick,
        ...(k.ALPACA_PAPER_KEY_ID
          ? { ALPACA_PAPER_KEY_ID: k.ALPACA_PAPER_KEY_ID, ALPACA_PAPER_SECRET: k.ALPACA_PAPER_SECRET ?? "" }
          : {}),
      }),
      { mode: 0o600 },
    );
    try {
      w(["secret", "bulk", sentFile, "-c", sentPath], "sentinel secrets");
    } finally {
      rmSync(sentFile, { force: true });
    }
  }
  return {
    url,
    sentinelUrl,
    d1: { journal, lab },
    kv,
    steps,
    cloud: { url: url ?? "", worker: o.name, ingest_hmac: ingest },
  };
}
