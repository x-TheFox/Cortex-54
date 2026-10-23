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
  budget: { mode: string; worst: { resource: string; fraction: number }; fractions: Record<string, number> };
  journalHead: { seq: number; sha: string };
  outboxPending: number;
  equity: Partial<Record<AccountId, number[][]>>;
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

  const load = useCallback(async () => {
    if (path === null) return;
    try {
      const d = await api<T>(path);
      if (!alive.current) return;
      setData(d);
      setError(null);
      setSignedOut(false);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!alive.current) return;
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
