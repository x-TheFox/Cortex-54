import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PoolConfigSchema } from "../src/court/pool.ts";
import { accountFor, secretBackend } from "./keychain.ts";

/**
 * Local-mode configuration (ADR-064): one JSON file in the Savant home (default ~/.cortex54, override with
 * CORTEX_HOME), readable only by the user. Holds the user's own keys; nothing in it ever leaves the machine except to
 * the provider each key belongs to.
 */

export const KEY_NAMES = [
  "ALPACA_PAPER_KEY_ID",
  "ALPACA_PAPER_SECRET",
  /** ADR-083: the user's live (real-money) Alpaca account; LIVE stays at Stop 0 until they ratify */
  "ALPACA_LIVE_KEY_ID",
  "ALPACA_LIVE_SECRET",
  /** ADR-086: the licence key from the customer's Whop order (refreshes the machine-bound licence token daily) */
  "SAVANT_LICENSE_KEY",
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
  // in keychain mode these live in the keychain and the file holds "" (audit F-A6-07); loadConfig merges them back
  secrets: z.object({
    web_session: z.string().min(32).or(z.literal("")),
    ingest_hmac: z.string().min(32).or(z.literal("")),
    pill_token: z.string().min(32).or(z.literal("")),
  }),
  keys: z.partialRecord(z.enum(KEY_NAMES), z.string()).default({}),
  /** ADR-072: the user's own model endpoints (any number) and how the court uses the pool */
  llm: PoolConfigSchema.default({
    endpoints: [],
    prefs: { prefer: "free_first", round_robin: true, allow_same_model: false, demoted: [] },
  }),
  /** ADR-073: first-run onboarding finished (the app shows the welcome screen until then) */
  onboarded: z.boolean().default(false),
  /** ADR-087: which legal set the user accepted, and when (null = not yet; entries stay held until they do) */
  terms: z.object({ version: z.string(), accepted_at: z.number().int() }).nullable().default(null),
  /**
   * ADR-075: court hearings per UTC day. Unset = the doctrine's 12 (protects free-tier quotas). A pool with paid
   * models can run more; each hearing is ~9 model calls.
   */
  court: z.object({ max_per_day: z.number().int().min(1).max(60).optional() }).default({}),
  /**
   * ADR-076: phone access on this Wi-Fi. Off = the app listens on this computer only. On = it also answers on the
   * local network (plain HTTP inside your network), and a phone pairs with a one-time QR code. Settings and keys can
   * only be changed from this computer either way.
   */
  lan: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /** ADR-076: where keys are kept: this file (mode 600) or the system keychain (macOS Keychain, libsecret, DPAPI) */
  secret_store: z.enum(["file", "keychain"]).default("file"),
  /** ADR-065: the user's own cloud brain (savant deploy), which this machine serves as a research runner */
  cloud: z.object({ url: z.string(), worker: z.string(), ingest_hmac: z.string().min(32) }).optional(),
});
export type LocalConfig = z.infer<typeof LocalConfigSchema>;

/**
 * The Savant home (ADR-085): SAVANT_HOME (or the older CORTEX_HOME), else ~/.savant. A computer that already has the
 * pre-rebrand ~/.cortex54 keeps using it, so nobody's settings, keys or journal move.
 */
export function cortexHome(): string {
  const env = process.env.SAVANT_HOME || process.env.CORTEX_HOME;
  if (env) return env;
  const legacy = join(homedir(), ".cortex54");
  const home = join(homedir(), ".savant");
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
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

/** What lives in the keychain when `secret_store` is "keychain": every key the user typed. */
const VaultSchema = z.object({
  keys: z.partialRecord(z.enum(KEY_NAMES), z.string()).default({}),
  endpoint_keys: z.record(z.string(), z.string()).default({}),
  /** audit F-A6-07: the app's own session/signing secrets, so config.json holds no secret at all in keychain mode */
  secrets: z.record(z.string(), z.string()).default({}),
});

/** Fill any secret that is missing (an older vault, or a file from before keychain mode kept them). */
function withSecrets(s: LocalConfig["secrets"], vault: Record<string, string>): LocalConfig["secrets"] {
  const pick = (k: keyof LocalConfig["secrets"]) => (vault[k] || s[k] || secret()) as string;
  return {
    web_session: pick("web_session"),
    ingest_hmac: pick("ingest_hmac"),
    pill_token: pick("pill_token"),
  };
}

export function loadConfig(home = cortexHome()): LocalConfig | null {
  const p = configPath(home);
  if (!existsSync(p)) return null;
  const cfg = LocalConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  if (cfg.secret_store !== "keychain") return { ...cfg, secrets: withSecrets(cfg.secrets, {}) };
  const raw = secretBackend(home).get(accountFor(home));
  const v = VaultSchema.parse(raw ? JSON.parse(raw) : {});
  return {
    ...cfg,
    secrets: withSecrets(cfg.secrets, v.secrets),
    keys: { ...cfg.keys, ...v.keys },
    llm: {
      ...cfg.llm,
      endpoints: cfg.llm.endpoints.map((e) => ({ ...e, key: v.endpoint_keys[e.id] ?? e.key })),
    },
  };
}

export function saveConfig(cfg: LocalConfig, home = cortexHome()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = configPath(home);
  let onDisk = LocalConfigSchema.parse(cfg);
  const backend = secretBackend(home);
  if (onDisk.secret_store === "keychain") {
    // keys go to the keychain first; only when it kept them does the file lose them
    backend.set(
      accountFor(home),
      JSON.stringify({
        keys: onDisk.keys,
        endpoint_keys: Object.fromEntries(
          onDisk.llm.endpoints.filter((e) => e.key).map((e) => [e.id, e.key]),
        ),
        secrets: onDisk.secrets,
      }),
    );
    onDisk = {
      ...onDisk,
      // the tray reads the read-only status token from this file, so it stays; the signing secrets don't
      secrets: { web_session: "", ingest_hmac: "", pill_token: onDisk.secrets.pill_token },
      keys: {},
      llm: { ...onDisk.llm, endpoints: onDisk.llm.endpoints.map((e) => ({ ...e, key: "" })) },
    };
  } else if (wasKeychain(p)) {
    // moved back to the file: don't leave a stale copy in the keychain
    try {
      backend.del(accountFor(home));
    } catch {
      /* nothing there */
    }
  }
  writeFileSync(p, `${JSON.stringify(onDisk, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows: per-user profile ACLs */
  }
  return p;
}

function wasKeychain(p: string): boolean {
  try {
    return existsSync(p) && JSON.parse(readFileSync(p, "utf8")).secret_store === "keychain";
  } catch {
    return false;
  }
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
