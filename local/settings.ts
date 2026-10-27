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
import { ntfyUrl } from "../src/notify/push.ts";
import type { WebSettings } from "../src/web/api.ts";
import { AGENT_PROMPT } from "./agent-prompt.ts";
import { KEY_NAMES, type KeyName, type LocalConfig, LocalConfigSchema, saveConfig } from "./config.ts";
import { configChecks, runtimeChecks } from "./health.ts";

/**
 * Settings for local mode (ADR-071/072/073): the web app's Settings page and first-run onboarding, and the CLI's
 * `cortex llm` commands, all go through here. Secrets are never sent back to the browser: the view shows whether a
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
        enabled: r.enabled !== false,
      }),
    );
  }
  return out;
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

  /** HEALTH (ADR-073): the same checks as `cortex doctor`, plus what only a running brain knows. */
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
      if (q.kind === "alpaca") {
        const keyId = str("keyId") || c.keys.ALPACA_PAPER_KEY_ID || "";
        const secret = str("secret") || c.keys.ALPACA_PAPER_SECRET || "";
        if (!keyId || !secret) return { ok: false, message: "Paste both the key id and the secret." };
        const a = await new AlpacaClient(
          "https://paper-api.alpaca.markets",
          { keyId, secret },
          () => undefined,
          this.f,
        ).account();
        return {
          ok: true,
          message: `Connected to your paper account: equity $${Number(a.equity).toFixed(2)}.`,
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
      if (c.mode === "paper" && !(c.keys.ALPACA_PAPER_KEY_ID && c.keys.ALPACA_PAPER_SECRET))
        return {
          ok: false,
          message: "Paper mode needs your Alpaca paper key id and secret (or stay in demo mode).",
        };
      c = LocalConfigSchema.parse(c);
    } catch (e) {
      return { ok: false, message: plain(e) };
    }
    saveConfig(c, this.d.home);
    setTimeout(() => this.d.reload(), 250);
    return { ok: true, message: "Saved. Applying now (a few seconds)." };
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
