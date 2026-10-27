import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PoolConfigSchema } from "../src/court/pool.ts";

/**
 * Local-mode configuration (ADR-064): one JSON file in the CORTEX home (default ~/.cortex54, override with
 * CORTEX_HOME), readable only by the user. Holds the user's own keys; nothing in it ever leaves the machine except to
 * the provider each key belongs to.
 */

export const KEY_NAMES = [
  "ALPACA_PAPER_KEY_ID",
  "ALPACA_PAPER_SECRET",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CHANNELS",
  "NTFY_TOPIC",
  "NTFY_URL",
  "SEC_USER_AGENT",
  "FMP_API_KEY",
  "FRED_API_KEY",
  "HUB_URL",
  "HUB_AGENT_KEY",
  "HUB_AGENT_NAME",
  "HUB_PUBLISH",
  "HUB_FOLLOW",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export const LocalConfigSchema = z.object({
  version: z.literal(1),
  /** demo = keyless simulated broker on live crypto prices; paper = the user's own Alpaca paper account */
  mode: z.enum(["demo", "paper"]),
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(8754),
  /**
   * Clef + Clairic: auto = Cloudflare Workers AI when its key is set, else the user's LLM as a structured stand-in
   * (slightly weaker); cloudflare = only Workers AI; llm = always the stand-in; off = funnel disabled.
   */
  clef: z
    .preprocess((v) => (v === "shim" ? "llm" : v), z.enum(["auto", "cloudflare", "llm", "off"]))
    .default("auto"),
  research: z
    .object({ enabled: z.boolean().default(true), max_parallel: z.number().int().min(1).max(4).default(2) })
    .default({ enabled: true, max_parallel: 2 }),
  starting_cash: z.number().positive().default(54),
  secrets: z.object({
    web_session: z.string().min(32),
    ingest_hmac: z.string().min(32),
    pill_token: z.string().min(32),
  }),
  keys: z.partialRecord(z.enum(KEY_NAMES), z.string()).default({}),
  /** ADR-072: the user's own model endpoints (any number) and how the court uses the pool */
  llm: PoolConfigSchema.default({
    endpoints: [],
    prefs: { prefer: "free_first", round_robin: true, allow_same_model: false },
  }),
  /** ADR-073: first-run onboarding finished (the app shows the welcome screen until then) */
  onboarded: z.boolean().default(false),
  /** ADR-065: the user's own cloud brain (cortex deploy), which this machine serves as a research runner */
  cloud: z.object({ url: z.string(), worker: z.string(), ingest_hmac: z.string().min(32) }).optional(),
});
export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function cortexHome(): string {
  return process.env.CORTEX_HOME || join(homedir(), ".cortex54");
}

export const configPath = (home = cortexHome()) => join(home, "config.json");

const secret = () => randomBytes(24).toString("hex");

export function newConfig(mode: LocalConfig["mode"] = "demo"): LocalConfig {
  return LocalConfigSchema.parse({
    version: 1,
    mode,
    secrets: { web_session: secret(), ingest_hmac: secret(), pill_token: secret() },
    keys: {},
  });
}

export function loadConfig(home = cortexHome()): LocalConfig | null {
  const p = configPath(home);
  if (!existsSync(p)) return null;
  return LocalConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function saveConfig(cfg: LocalConfig, home = cortexHome()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = configPath(home);
  writeFileSync(p, `${JSON.stringify(LocalConfigSchema.parse(cfg), null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows: per-user profile ACLs */
  }
  return p;
}

/** `KEY=VALUE` pairs from the CLI or an agent (unknown names refused, so a typo can't hide). */
export function applyKeys(cfg: LocalConfig, pairs: string[]): LocalConfig {
  const keys = { ...cfg.keys };
  for (const p of pairs) {
    const i = p.indexOf("=");
    const k = p.slice(0, i) as KeyName;
    if (i <= 0 || !(KEY_NAMES as readonly string[]).includes(k))
      throw new Error(`unknown key ${p.slice(0, Math.max(i, 0)) || p}`);
    const v = p.slice(i + 1).trim();
    if (v) keys[k] = v;
    else delete keys[k];
  }
  return { ...cfg, keys };
}

/** Redacted view for status/doctor output: names only, never values. */
export function keyNames(cfg: LocalConfig): string[] {
  return Object.keys(cfg.keys).sort();
}
