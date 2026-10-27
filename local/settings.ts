import { AlpacaClient } from "../src/broker/AlpacaClient.ts";
import { CloudflareRestAi } from "../src/clef/portable.ts";
import { type ApiFormat, listModels, normalizeUrl, PRESETS, presetForKey } from "../src/court/models.ts";
import {
  type Endpoint,
  EndpointSchema,
  endpointProvider,
  PoolPrefsSchema,
  type PoolReport,
} from "../src/court/pool.ts";
import { discordSetup } from "../src/discord/setup.ts";
import { DOCTRINE } from "../src/generated/config.ts";
import { TERMS_VERSION } from "../src/legal/version.ts";
import { ntfyUrl } from "../src/notify/push.ts";
import type { WebSettings } from "../src/web/api.ts";
import { AGENT_PROMPT } from "./agent-prompt.ts";
import {
  backupFileName,
  makeBackup,
  type OpenedBackup,
  openBackup,
  restoredConfig,
  restoreInto,
} from "./backup.ts";
import { KEY_NAMES, type KeyName, type LocalConfig, LocalConfigSchema, saveConfig } from "./config.ts";
import { configChecks, runtimeChecks } from "./health.ts";
import { secretBackend } from "./keychain.ts";
import { activateKey, installLicense, readLicense, releaseKey, STORE_URL } from "./license.ts";

/**
 * Settings for local mode (ADR-071/072/073): the web app's Settings page and first-run onboarding, and the CLI's
 * `savant llm` commands, all go through here. Secrets are never sent back to the browser: the view shows whether a
 * key is set and its last four characters. Saving writes config.json (mode 600) and reloads the brain in-process.
 */

type Fetch = (u: string, i?: RequestInit) => Promise<Response>;

const hint = (v: string | undefined) => (v ? `…${v.slice(-4)}` : "");

/** Keys the settings page may set (ingest/web/pill secrets are generated, never typed). */
const EDITABLE = new Set<string>(KEY_NAMES);

export function endpointId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 18) || "endpoint";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Merge endpoints from the page: a blank key keeps the key already saved for that id. */
export function mergeEndpoints(old: Endpoint[], incoming: unknown[]): Endpoint[] {
  const byId = new Map(old.map((e) => [e.id, e]));
  const taken = new Set<string>();
  const out: Endpoint[] = [];
  for (const raw of incoming) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const prev = typeof r.id === "string" ? byId.get(r.id) : undefined;
    const name = String(r.name ?? prev?.name ?? "Endpoint");
    const id = prev?.id && !taken.has(prev.id) ? prev.id : endpointId(name, taken);
    taken.add(id);
    const format = (r.format === "anthropic" ? "anthropic" : "openai") as ApiFormat;
    out.push(
      EndpointSchema.parse({
        id,
        name,
        format,
        url: normalizeUrl(format, String(r.url ?? prev?.url ?? "")),
        key: typeof r.key === "string" && r.key !== "" ? r.key : (prev?.key ?? ""),
        models: Array.isArray(r.models) ? r.models.map(String).filter(Boolean) : (prev?.models ?? []),
        tier:
          r.tier === "free" || r.tier === "local"
            ? r.tier
            : r.tier === "paid"
              ? "paid"
              : (prev?.tier ?? "paid"),
        ...(typeof r.daily_cap === "number" && r.daily_cap > 0 ? { daily_cap: Math.floor(r.daily_cap) } : {}),
        ...num(r, prev, "price_in"),
        ...num(r, prev, "price_out"),
        ...num(r, prev, "daily_spend_cap"),
        enabled: r.enabled !== false,
      }),
    );
  }
  return out;
}

/**
 * A number field from the page: a number sets it, null clears it, a missing field keeps the saved value. A price of 0
 * is valid (a free endpoint with a meter); a spend cap must be positive.
 */
function num(
  r: Record<string, unknown>,
  prev: Endpoint | undefined,
  k: "price_in" | "price_out" | "daily_spend_cap",
): Partial<Record<typeof k, number>> {
  const v = r[k];
  if (v === null) return {};
  if (typeof v === "number" && Number.isFinite(v) && (k === "daily_spend_cap" ? v > 0 : v >= 0))
    return { [k]: v };
  if (v === undefined && prev?.[k] !== undefined) return { [k]: prev[k] as number };
  return {};
}

export interface SettingsDeps {
  home: string;
  cfg: () => LocalConfig;
  /** apply saved settings (the CLI rebuilds the brain in-process) */
  reload: () => void;
  pool: () => PoolReport | null;
  clef: () => { ok: boolean; level: string; text: string };
  /** the running brain's /health (heartbeat, jobs, invariants) */
  health?: () => Record<string, unknown>;
  fetcher?: Fetch;
  /** ADR-075: today's tokens and cost per priced provider */
  spend?: () => { provider: string; input: number; output: number; usd: number; cap: number | null }[];
  /** ADR-076: consistent copies of the brain's databases (and local files) for a backup */
  snapshot?: () => Record<string, Buffer>;
  /** ADR-076: stop the brain, run `write` (files + config), start it again */
  swap?: (write: () => void) => Promise<void>;
  /** ADR-076: a one-time login link on this computer's Wi-Fi address (null when LAN access is off) */
  pairLink?: () => Promise<string | null>;
  /** ADR-076: stop the service and wipe the Savant home */
  wipe?: () => Promise<void>;
  /** ADR-081: cap the paper account's borrowing at 1x at the broker */
  cashOnly?: (account: "PAPER" | "LIVE") => Promise<{ ok: boolean; message: string }>;
  /** ADR-081: the PAPER account's mode and why (so the page can offer the fix) */
  account?: () => { mode: string; reason: string | null; startUsd: number; equityUsd: number | null } | null;
  /** ADR-083: the LIVE account's state (null when no live keys) */
  liveAccount?: () => {
    mode: string;
    reason: string | null;
    equityUsd: number | null;
    autonomyStop: number;
  } | null;
}

export class LocalSettings implements WebSettings {
  constructor(private readonly d: SettingsDeps) {}

  /** apply the config file as it is now (the CLI's file watcher calls this) */
  reloadNow(): void {
    this.d.reload();
  }

  private get f(): Fetch {
    return this.d.fetcher ?? ((u, i) => fetch(u, i));
  }

  async view(): Promise<unknown> {
    const c = this.d.cfg();
    const keys = Object.fromEntries(
      KEY_NAMES.map((k) => [
        k,
        { set: Boolean(c.keys[k]), hint: k === "DISCORD_CHANNELS" ? "" : hint(c.keys[k]) },
      ]),
    );
    return {
      managed: "local",
      mode: c.mode,
      onboarded: c.onboarded,
      clefMode: c.clef,
      keys,
      llm: {
        prefs: c.llm.prefs,
        endpoints: c.llm.endpoints.map((e) => ({
          ...e,
          key: "",
          keySet: Boolean(e.key),
          keyHint: hint(e.key),
        })),
      },
      pool: this.d.pool(),
      clef: this.d.clef(),
      spend: this.d.spend?.() ?? [],
      court: {
        max_per_day: c.court.max_per_day ?? null,
        default_per_day: DOCTRINE.funnel.tier3.max_sprints_per_day,
      },
      lan: { enabled: c.lan.enabled, port: c.port },
      secretStore: { mode: c.secret_store, backend: keychainName(this.d.home) },
      terms: {
        current: TERMS_VERSION,
        accepted: c.terms?.version === TERMS_VERSION,
        acceptedAt: c.terms?.accepted_at ?? null,
      },
      license: readLicense(this.d.home),
      licenseKey: { set: Boolean(c.keys.SAVANT_LICENSE_KEY), hint: hint(c.keys.SAVANT_LICENSE_KEY) },
      storeUrl: STORE_URL,
      account: this.d.account?.() ?? null,
      live: this.d.liveAccount?.() ?? null,
      discord: {
        connected: Boolean(c.keys.DISCORD_BOT_TOKEN && c.keys.DISCORD_CHANNELS),
        channels: Object.keys(safeJson(c.keys.DISCORD_CHANNELS)),
      },
      push: { topic: Boolean(c.keys.NTFY_TOPIC), url: ntfyUrl(c.keys.NTFY_TOPIC, c.keys.NTFY_URL) },
      presets: PRESETS,
      agentPrompt: AGENT_PROMPT,
      freeChains: {
        gemini: DOCTRINE.llm_routing.bull_chain.filter((h) => h.provider === "gemini").map((h) => h.model),
        groq: [
          ...new Set(
            [...DOCTRINE.llm_routing.bull_chain, ...DOCTRINE.llm_routing.bear_chain]
              .filter((h) => h.provider === "groq")
              .map((h) => h.model),
          ),
        ],
        nim: [
          ...new Set(
            [...DOCTRINE.llm_routing.bull_chain, ...DOCTRINE.llm_routing.bear_chain]
              .filter((h) => h.provider === "nim")
              .map((h) => h.model),
          ),
        ],
      },
    };
  }

  /** HEALTH (ADR-073): the same checks as `savant doctor`, plus what only a running brain knows. */
  async checks(): Promise<unknown> {
    const c = this.d.cfg();
    const h = this.d.health?.();
    return {
      checks: [
        ...(await configChecks(c, this.d.home, this.f)),
        ...(h ? runtimeChecks(h as Parameters<typeof runtimeChecks>[0]) : []),
      ],
    };
  }

  /**
   * A support file (ADR-073): everything a helper needs and nothing secret. Key names only (never values), endpoint
   * hosts without keys, health, checks, pool notes, versions. The user sees it and decides whether to send it.
   */
  async support(): Promise<Record<string, unknown>> {
    const c = this.d.cfg();
    return {
      kind: "cortex-54-support",
      made_at: new Date().toISOString(),
      versions: { node: process.versions.node, platform: process.platform, arch: process.arch },
      mode: c.mode,
      onboarded: c.onboarded,
      clef_mode: c.clef,
      research: c.research,
      keys_set: KEY_NAMES.filter((k) => Boolean(c.keys[k])),
      endpoints: c.llm.endpoints.map((e) => ({
        name: e.name,
        format: e.format,
        host: safeHost(e.url),
        tier: e.tier,
        models: e.models,
        key_set: Boolean(e.key),
        enabled: e.enabled,
        daily_cap: e.daily_cap ?? null,
      })),
      prefs: c.llm.prefs,
      pool: this.d.pool(),
      clef: this.d.clef(),
      health: this.d.health?.() ?? null,
      checks: ((await this.checks()) as { checks: unknown[] }).checks,
    };
  }

  /** Discover models. `side` = an endpoint id whose saved key to use when `key` is blank, or a built-in key name. */
  async models(q: { format: string; url: string; key: string; side: string }): Promise<unknown> {
    const c = this.d.cfg();
    const saved =
      c.llm.endpoints.find((e) => e.id === q.side)?.key ??
      (EDITABLE.has(q.side) ? c.keys[q.side as KeyName] : "");
    const format: ApiFormat = q.format === "anthropic" ? "anthropic" : "openai";
    return listModels(format, q.url, q.key || saved || "", this.f);
  }

  /** Find models already running on this computer (Ollama, LM Studio). */
  async detect(): Promise<unknown> {
    const found = [];
    for (const p of PRESETS.filter((x) => x.tier === "local")) {
      const r = await listModels(p.format, p.url, "", this.f);
      if (r.ok && r.models.length) found.push({ preset: p.id, name: p.name, url: r.url, models: r.models });
    }
    return { found };
  }

  /** Try something for real: an Alpaca paper key, Cloudflare AI, or one model on an endpoint. */
  async test(q: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const c = this.d.cfg();
    const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
    try {
      if (q.kind === "alpaca" || q.kind === "alpaca_live") {
        // ADR-083: reads the account only; nothing is ever placed from a test
        const live = q.kind === "alpaca_live";
        const keyId = str("keyId") || (live ? c.keys.ALPACA_LIVE_KEY_ID : c.keys.ALPACA_PAPER_KEY_ID) || "";
        const secret = str("secret") || (live ? c.keys.ALPACA_LIVE_SECRET : c.keys.ALPACA_PAPER_SECRET) || "";
        if (!keyId || !secret) return { ok: false, message: "Paste both the key id and the secret." };
        const a = await new AlpacaClient(
          live ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets",
          { keyId, secret },
          () => undefined,
          this.f,
        ).account();
        const margin = Number(a.multiplier ?? 1) > 1;
        return {
          ok: true,
          message: `Connected to your ${live ? "live (real-money)" : "paper"} account: equity $${Number(a.equity).toFixed(2)}.${margin ? " It allows margin: Savant holds new trades until you make it cash-only (button below, after saving)." : ""}`,
        };
      }
      if (q.kind === "cloudflare") {
        const acct = str("accountId") || c.keys.CLOUDFLARE_ACCOUNT_ID || "";
        const tok = str("token") || c.keys.CLOUDFLARE_API_TOKEN || "";
        if (!acct || !tok) return { ok: false, message: "Paste the account id and the API token." };
        const ai = new CloudflareRestAi(acct, tok, this.f);
        await ai.run("@cf/cloudflare/clef-flash", {
          model: "clef-flash",
          state: { text: "connection test" },
          questions: { ok: { type: "noul", instructions: "Is this a connection test?" } },
        });
        return { ok: true, message: "Cloudflare AI answered: Clef and Clairic are ready." };
      }
      if (q.kind === "model") {
        const ep = c.llm.endpoints.find((e) => e.id === str("endpoint"));
        const raw =
          ep ??
          EndpointSchema.parse({
            id: "test",
            name: "test",
            format: str("format") === "anthropic" ? "anthropic" : "openai",
            url: normalizeUrl(str("format") === "anthropic" ? "anthropic" : "openai", str("url")),
            key: str("key"),
            models: [str("model")],
          });
        const model = str("model") || raw.models[0] || "";
        const t0 = Date.now();
        const res = await endpointProvider(raw, this.f).complete(
          model,
          {
            system: "Reply with JSON only.",
            user: 'Return {"ok": true}.',
            maxOutputTokens: 64,
            schema: { type: "object" },
          },
          45_000,
        );
        const okJson = /"ok"\s*:\s*true/.test(res.text);
        return {
          ok: okJson,
          message: okJson
            ? `${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)} s with valid JSON.`
            : `${model} answered, but not with the JSON asked for. It may still work; the court checks every answer.`,
        };
      }
      return { ok: false, message: "Unknown test." };
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
  }

  async save(patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    let c = this.d.cfg();
    try {
      if (patch.mode === "demo" || patch.mode === "paper") c = { ...c, mode: patch.mode };
      if (
        patch.clef === "auto" ||
        patch.clef === "cloudflare" ||
        patch.clef === "llm" ||
        patch.clef === "off"
      )
        c = { ...c, clef: patch.clef };
      if (typeof patch.onboarded === "boolean") c = { ...c, onboarded: patch.onboarded };
      if (patch.terms && typeof patch.terms === "object") {
        const t = patch.terms as { version?: unknown; accepted_at?: unknown };
        if (t.version === TERMS_VERSION && typeof t.accepted_at === "number")
          c = { ...c, terms: { version: TERMS_VERSION, accepted_at: Math.floor(t.accepted_at) } };
      }
      if (patch.court && typeof patch.court === "object") {
        const v = (patch.court as { max_per_day?: unknown }).max_per_day;
        c = {
          ...c,
          court:
            typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 60
              ? { max_per_day: v }
              : v === null
                ? {}
                : c.court,
        };
      }
      if (patch.lan && typeof patch.lan === "object")
        c = { ...c, lan: { enabled: (patch.lan as { enabled?: unknown }).enabled === true } };
      if (patch.secret_store === "file" || patch.secret_store === "keychain") {
        if (patch.secret_store === "keychain" && !secretBackend(this.d.home).available())
          return {
            ok: false,
            message: "No system keychain was found on this computer; keys stay in the settings file.",
          };
        c = { ...c, secret_store: patch.secret_store };
      }
      if (patch.keys && typeof patch.keys === "object") {
        const keys = { ...c.keys };
        for (const [k, v] of Object.entries(patch.keys as Record<string, unknown>)) {
          if (!EDITABLE.has(k)) return { ok: false, message: `Unknown setting ${k}.` };
          if (v === null) delete keys[k as KeyName];
          else if (typeof v === "string" && v.trim()) keys[k as KeyName] = v.trim();
        }
        c = { ...c, keys };
      }
      if (patch.llm && typeof patch.llm === "object") {
        const l = patch.llm as { endpoints?: unknown[]; prefs?: unknown };
        c = {
          ...c,
          llm: {
            endpoints: Array.isArray(l.endpoints)
              ? mergeEndpoints(c.llm.endpoints, l.endpoints)
              : c.llm.endpoints,
            prefs: l.prefs ? PoolPrefsSchema.parse({ ...c.llm.prefs, ...(l.prefs as object) }) : c.llm.prefs,
          },
        };
      }
      if (Boolean(c.keys.ALPACA_LIVE_KEY_ID) !== Boolean(c.keys.ALPACA_LIVE_SECRET))
        return { ok: false, message: "The live account needs both its key id and its secret." };
      if (c.mode === "paper" && !(c.keys.ALPACA_PAPER_KEY_ID && c.keys.ALPACA_PAPER_SECRET))
        return {
          ok: false,
          message: "Paper mode needs your Alpaca paper key id and secret (or stay in demo mode).",
        };
      c = LocalConfigSchema.parse(c);
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
    try {
      saveConfig(c, this.d.home);
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
    setTimeout(() => this.d.reload(), 250);
    return { ok: true, message: "Saved. Applying now (a few seconds)." };
  }

  /** ADR-076: an encrypted backup file, returned to the browser as text (it saves it as a download). */
  async backup(q: { passphrase: string; includeKeys: boolean }) {
    try {
      const file = makeBackup({
        cfg: this.d.cfg(),
        includeKeys: q.includeKeys,
        passphrase: q.passphrase,
        files: this.d.snapshot?.() ?? {},
      });
      return {
        ok: true,
        message: `Backup ready${q.includeKeys ? " (with your keys)" : " (without keys)"}. Keep the passphrase: nobody can open the file without it.`,
        file,
        name: backupFileName(),
      };
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
  }

  /** ADR-076: restore a backup from another computer. The brain stops, the files are swapped, it starts again. */
  async restore(q: { file: string; passphrase: string }) {
    let b: OpenedBackup;
    try {
      b = openBackup(q.file, q.passphrase);
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
    if (!this.d.swap)
      return { ok: false, message: "Restore isn't available here; use `savant restore` instead." };
    const home = this.d.home;
    const current = this.d.cfg();
    const swap = this.d.swap;
    const mode = restoredConfig(b, current).mode;
    // answer first: the swap stops this very server (same as a settings save, which reloads after replying)
    setTimeout(
      () =>
        void swap(() => {
          saveConfig(restoreInto(home, b, current), home);
        }).catch((e) => console.error(`[restore] ${String(e).slice(0, 200)}`)),
      300,
    );
    return {
      ok: true,
      message: `Restoring the backup from ${b.madeAt.slice(0, 10)} (${mode} mode): Savant restarts on it in a few seconds.${b.withKeys ? "" : " It had no keys: add them in SETTINGS."} If the old computer still runs Savant on the same paper account, stop it there.`,
    };
  }

  /** ADR-081: make the paper account cash-only at the broker (the user presses the button). */
  async cashOnly(account: "PAPER" | "LIVE" = "PAPER") {
    if (!this.d.cashOnly) return { ok: false, message: "Not available here." };
    try {
      return await this.d.cashOnly(account);
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
  }

  /** ADR-087: record that the user accepted the current legal set. */
  async terms(q: { accept: boolean }) {
    if (!q.accept) return { ok: false, message: "Tick the box to accept the terms first." };
    await this.save({ terms: { version: TERMS_VERSION, accepted_at: Date.now() } });
    return { ok: true, message: "Thanks. Savant can trade now." };
  }

  /** ADR-077: install a licence file (checked against this build's publisher key before it is saved). */
  async license(q: { file?: string; key?: string; release?: boolean }) {
    const c = this.d.cfg();
    // ADR-086: a Whop licence key → the licence server → a token bound to this computer
    if (q.release) {
      const key = c.keys.SAVANT_LICENSE_KEY;
      if (!key) return { ok: false, message: "No licence key is saved on this computer." };
      const r = await releaseKey(this.d.home, key, this.d.fetcher ? { fetcher: this.d.fetcher } : {});
      if (r.ok) await this.save({ keys: { SAVANT_LICENSE_KEY: null } });
      return r;
    }
    if (q.key) {
      const r = await activateKey(this.d.home, q.key, {
        app: "desktop",
        ...(this.d.fetcher ? { fetcher: this.d.fetcher } : {}),
      });
      if (!r.ok) return r;
      await this.save({ keys: { SAVANT_LICENSE_KEY: q.key.trim() } });
      return { ok: true, message: `${r.message} Paper and live trading are unlocked.` };
    }
    try {
      const st = installLicense(this.d.home, q.file ?? "");
      setTimeout(() => this.d.reload(), 250);
      return {
        ok: true,
        message:
          st.required && st.ok
            ? `Licence for ${st.license.licensee} (${st.license.plan}) installed${st.daysLeft === null ? "" : `, ${st.daysLeft} days left`}.`
            : "This build doesn't need a licence.",
      };
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
  }

  /** ADR-076: a one-time login link for a phone on this Wi-Fi. */
  async pair() {
    if (!this.d.cfg().lan.enabled) return { ok: false, message: "Turn on phone access first." };
    const url = await this.d.pairLink?.();
    return url
      ? {
          ok: true,
          message: "Scan with your phone's camera within 10 minutes. The link works once.",
          url,
        }
      : { ok: false, message: "This computer has no Wi-Fi/LAN address right now." };
  }

  /** ADR-076: "reset this computer" — only after the user types RESET. */
  async reset(q: { confirm: string }) {
    if (q.confirm !== "RESET") return { ok: false, message: "Type RESET to confirm." };
    if (!this.d.wipe)
      return { ok: false, message: "Reset isn't available here; delete the Savant folder by hand." };
    setTimeout(() => void this.d.wipe?.(), 300);
    return {
      ok: true,
      message: "Resetting: Savant stops and deletes its settings, keys and history on this computer.",
    };
  }

  async discord(q: { token: string; guildId: string }): Promise<unknown> {
    const c = this.d.cfg();
    const token = q.token.trim() || c.keys.DISCORD_BOT_TOKEN || "";
    if (!token) return { ok: false, message: "Paste your bot token first." };
    try {
      // local mode: notifications only (slash commands need a public URL, which only the cloud brain has)
      const r = await discordSetup({ token, guildId: q.guildId || undefined, fetcher: this.f });
      if (!r.ok) return r;
      await this.save({ keys: { DISCORD_BOT_TOKEN: token, DISCORD_CHANNELS: JSON.stringify(r.channels) } });
      return {
        ok: true,
        message: `Connected to ${r.guild.name}. ${r.created.length ? `Created ${r.created.length} channel(s).` : "Channels already existed."} Alerts will appear there too.`,
      };
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
  }
}

const keychainSeen = new Map<string, string | null>();
/** which system keychain this computer has (looked up once per process) */
function keychainName(home: string): string | null {
  if (!keychainSeen.has(home))
    try {
      const b = secretBackend(home);
      keychainSeen.set(home, b.available() ? b.name : null);
    } catch {
      keychainSeen.set(home, null);
    }
  return keychainSeen.get(home) ?? null;
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "?";
  }
}

function safeJson(s: string | undefined): Record<string, unknown> {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Errors in words a non-developer can act on. */
export function plain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/401|unauthori[sz]ed|invalid.*key|authentication/i.test(m))
    return "The key was rejected. Copy it again (no spaces).";
  if (/403|forbidden|permission/i.test(m))
    return "The key works but lacks permission for this. Check its scopes.";
  if (/404|not found/i.test(m)) return "Nothing at that address. Check the URL (and the model name).";
  if (/429|rate|quota/i.test(m))
    return "The provider is rate-limiting this key right now. Try again in a minute.";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(m))
    return "Could not reach it. Is the address right, and (for a local model) is the app running?";
  if (/timeout|abort/i.test(m)) return "It took too long to answer. Try again, or pick a smaller model.";
  return m.slice(0, 200);
}

/** For the CLI and onboarding: recognize a pasted key. */
export { presetForKey };
