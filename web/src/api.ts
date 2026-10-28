import { useCallback, useEffect, useRef, useState } from "react";

// Shapes returned by the worker's /api routes (src/web/api.ts). Kept local so the browser build never pulls in
// worker code; the brain's StatusView is the source of truth.

export type Band = "GREEN" | "YELLOW" | "ORANGE" | "RED";
export type AccountId = "PAPER" | "LIVE";

export interface Position {
  symbol: string;
  qty: string;
  avgEntry: string;
  stop: string;
  target: string;
  state: string;
  brokerStop: boolean;
}

export interface OpenOrder {
  coid?: string;
  symbol?: string;
  role?: string;
  side?: string;
  qty?: string;
  limit?: string | null;
  state?: string;
}

export interface AccountView {
  account: AccountId;
  configured: boolean;
  equityUsd: number | null;
  brokerEquityUsd: number | null;
  modeledCostUsd: number;
  hwmUsd: number | null;
  /** ADR-081: where this account started (older brains don't send it: $54) */
  startUsd?: number;
  rung: string;
  autonomyStop: number;
  breaker: Band;
  locked: boolean;
  mode: string;
  modeReason: string | null;
  reconciledAt: number | null;
  lastError: string | null;
  ordersToday: number;
  positions: Position[];
  openOrders?: OpenOrder[];
}

export interface RegimeView {
  arena: string;
  posture: string;
  score: number | null;
  ceiling: number | null;
  ageMinutes: number;
  fresh: boolean;
  source: string;
}

export interface StatusView {
  now: number;
  lastPulseAt: number | null;
  budget: {
    mode: string;
    worst: { resource: string; fraction: number };
    fractions: Record<string, number>;
    /** ADR-081: cloudflare = Workers Free quotas; workers_ai = only your Cloudflare AI allowance; none = not metered */
    scope?: "cloudflare" | "workers_ai" | "none";
    neurons?: Record<string, number>;
  };
  /** ADR-083: the Governor's LIVE graduation gate (null until it has run) */
  liveGate?: { at: number; rows: { criterion: string; status: string; value: string }[] } | null;
  /** ADR-075: model calls today per provider (local mode's gauge) */
  modelUse?: {
    worst: { provider: string; fraction: number };
    providers: { provider: string; calls: number; cap: number | null }[];
  };
  journalHead: { seq: number; sha: string };
  outboxPending: number;
  equity: Partial<Record<AccountId, number[][]>>;
  /** buy-and-hold BTC / SPY with the same starting equity (MLP0-024) */
  benchmark?: Partial<Record<AccountId, { btc: number[][]; spy: number[][] }>>;
  regimes: RegimeView[];
  accounts: AccountView[];
}

export interface CourtRow {
  ts: number;
  payload_json: string;
  symbol: string | null;
  thesis_summary: string | null;
  bear_case_brief: string | null;
  proposed_conviction: number | null;
  models_used: string | null;
}

export interface RejectionRow {
  ts: number;
  stage: string;
  symbol: string;
  arena: string;
  reason_codes: string;
}

export interface MemoryView {
  beliefs: { subject: string; statement: string; confidence: number }[];
  reputation: Record<string, { weight: number; signals: number }>;
  scars: { id: string; kind: string; rule: string; expires: string | null }[];
  scarFile: number;
  report: { produced_at: number; payload_json: string } | null;
}

export interface OptionsRow {
  trade_id: string;
  kind: "OPEN" | "CLOSE";
  ts: number;
  strategy: string;
  underlying: string;
  cash: number;
  max_loss_cents: number;
  pnl_cents: number | null;
  r: number | null;
  reason: string | null;
}

export class SignedOut extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", ...init });
  if (r.status === 401) throw new SignedOut("signed out");
  const body = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!r.ok) throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function command(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; message: string }> {
  return api("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cortex-web": "1" },
    body: JSON.stringify({ name, ...args }),
  });
}

/** Exchange a one-time `/#login=` token for a session cookie, then drop it from the address bar. */
export async function consumeLoginHash(): Promise<"none" | "ok" | "expired"> {
  const m = location.hash.match(/^#login=([\w.-]+)$/);
  if (!m) return "none";
  history.replaceState(null, "", location.pathname);
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t: m[1] }),
  });
  return r.ok ? "ok" : "expired";
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  signedOut: boolean;
  loading: boolean;
  updatedAt: number | null;
  reload: () => void;
}

/** Fetch `path`, re-polling every `pollMs` while the tab is visible (0 = once). */
export function useResource<T>(path: string | null, pollMs = 0): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const alive = useRef(true);
  /** Audit W3-27: only the newest request may update state (a slow old response must not overwrite a newer one). */
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (path === null) return;
    const mine = ++latest.current;
    try {
      const d = await api<T>(path);
      if (!alive.current || mine !== latest.current) return;
      setData(d);
      setError(null);
      setSignedOut(false);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!alive.current || mine !== latest.current) return;
      if (e instanceof SignedOut) setSignedOut(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    void load();
    if (!pollMs)
      return () => {
        alive.current = false;
      };
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    const onVis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive.current = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, pollMs]);

  return { data, error, signedOut, loading, updatedAt, reload: () => void load() };
}

/** Re-render every `ms` so relative times ("14 s ago") stay honest between polls. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** /api/forecast (ADR-047): Kronos's sampled view next to the robot's own plan for one symbol. */
export interface ForecastView {
  symbol: string;
  symbols: string[];
  now: number;
  kronos: {
    model: string;
    produced_at: number;
    stale: boolean;
    horizon_hours: number;
    horizon_label?: string;
    candle_hours: number;
    confidence: "LOW";
    about: string;
    last: number;
    hist: number[];
    fan: { p10: number[]; p50: number[]; p90: number[] } | null;
    p_up: number;
    p_win: number;
    exp_ret: number;
  } | null;
  robot: {
    position: {
      account: string;
      entry: number;
      stop: number;
      target: number;
      opened_at: number;
      max_hold_until: number;
    } | null;
    plan: {
      strategy: string;
      origin: string;
      created_at: number;
      entry_low: number;
      entry_high: number;
      stop: number;
      target: number;
      win_prob: number;
      bear_lethality: number;
      thesis: string;
    } | null;
    regime: { posture: string; score: number | null } | null;
  };
}

/** POST JSON to an /api route with the CSRF header (mutations). */
export async function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cortex-web": "1" },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ feed (ADR-071)

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  image?: { url: string };
}
export interface FeedItem {
  id: number;
  ts: number;
  channel: string;
  msg: { content?: string; embeds?: Embed[] };
}

// ------------------------------------------------------------------ settings (ADR-071/072/073)

export type ApiFormat = "openai" | "anthropic";
export type Tier = "free" | "paid" | "local";

export interface Preset {
  id: string;
  name: string;
  format: ApiFormat;
  url: string;
  tier: Tier;
  keyUrl: string | null;
  keyPattern: string | null;
  note: string;
  builtinKey?: string;
}

export interface EndpointView {
  id: string;
  name: string;
  format: ApiFormat;
  url: string;
  key: string;
  keySet: boolean;
  keyHint: string;
  models: string[];
  tier: Tier;
  daily_cap?: number;
  /** ADR-075: USD per 1M tokens, and a daily spend cap */
  price_in?: number;
  price_out?: number;
  daily_spend_cap?: number;
  enabled: boolean;
}

export interface PoolPrefs {
  prefer: "free_first" | "paid_first" | "mixed";
  round_robin: boolean;
  allow_same_model: boolean;
  /** ADR-075: `provider/model` the user demoted from the scoreboard */
  demoted?: string[];
}

export interface PoolReport {
  entries: { provider: string; model: string; tier: Tier; family: string; source: string }[];
  models: number;
  lineages: string[];
  notes: { level: "ok" | "warn" | "block"; text: string }[];
}

export interface SettingsView {
  managed: "local" | "cloud";
  message?: string;
  mode?: "demo" | "paper";
  onboarded?: boolean;
  clefMode?: "auto" | "cloudflare" | "llm" | "off";
  keys?: Record<string, { set: boolean; hint: string }>;
  llm?: { prefs: PoolPrefs; endpoints: EndpointView[] };
  pool?: PoolReport | null;
  clef?: { ok: boolean; level: "ok" | "degraded" | "off"; text: string };
  discord?: { connected: boolean; channels: string[] };
  push?: { topic: boolean; url: string | null };
  presets?: Preset[];
  freeChains?: Record<string, string[]>;
  agentPrompt?: string;
  /** ADR-075: today's tokens and cost per priced endpoint */
  spend?: { provider: string; input: number; output: number; usd: number; cap: number | null }[];
  court?: { max_per_day: number | null; default_per_day: number };
  /** ADR-076 */
  lan?: { enabled: boolean; port: number };
  secretStore?: { mode: "file" | "keychain"; backend: string | null };
  /** ADR-083: the live account (null without live keys) */
  live?: { mode: string; reason: string | null; equityUsd: number | null; autonomyStop: number } | null;
  /** ADR-081: the paper account's mode and why */
  account?: { mode: string; reason: string | null; startUsd: number; equityUsd: number | null } | null;
  /** ADR-091: what the weekly Governor would change, waiting for approval */
  proposals?: {
    calibration: {
      n: number;
      brierRaw: number | null;
      brierCalibrated: number | null;
      proposedAt: number | null;
    } | null;
    scars: { id: string; kind: string; rule: string }[];
  };
  /** ADR-087: the legal set the user accepted */
  terms?: { current: string; accepted: boolean; acceptedAt: number | null };
  /** ADR-086 */
  licenseKey?: { set: boolean; hint: string };
  storeUrl?: string;
  /** ADR-077 */
  license?:
    | { required: false }
    | {
        required: true;
        ok: true;
        license: { licensee: string; plan: string; expires_at: string | null };
        daysLeft: number | null;
      }
    | { required: true; ok: false; reason: string };
}

export type ModelList =
  | { ok: true; url: string; models: string[] }
  | { ok: false; url: string; error: string };
export type Result = { ok: boolean; message: string };

/** Recognize a pasted key from the presets' patterns (sk-ant-…, gsk_…, AIza…). */
export function presetFor(key: string, presets: Preset[]): Preset | null {
  const k = key.trim();
  for (const p of presets) if (p.keyPattern && new RegExp(p.keyPattern).test(k)) return p;
  return null;
}

/** After a save the local brain reloads for a moment; wait until it answers again. */
export async function waitForBrain(ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 900));
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch("/api/settings", { credentials: "same-origin" });
      if (r.ok) return true;
    } catch {
      /* reloading */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}
