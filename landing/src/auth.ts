/**
 * Sign in with Whop for getsavant.pro (ADR-093): OAuth 2.1 + PKCE against Whop's public client "Savant Account".
 * The code exchange and every account call go through /api (Vercel proxies it to the Savant licence Worker), so the
 * page's CSP stays 'self'. Tokens live in this browser only (localStorage); signing out revokes the refresh token.
 */
export const CLIENT_ID = "app_ge1Rv8QkJmsDdh";
const KEY = "savant.auth";
const PKCE = "savant.pkce";

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c] as string);
const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

function read<T>(store: Storage, k: string): T | null {
  try {
    return JSON.parse(store.getItem(k) ?? "null") as T | null;
  } catch {
    return null;
  }
}
function write(store: Storage, k: string, v: unknown): void {
  try {
    if (v === null) store.removeItem(k);
    else store.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked: sign-in lasts for this page only */
  }
}

/** The page's own address as the redirect URI (must match the app's registered URIs exactly). */
const redirectUri = () => `${location.origin}${location.pathname}`;

/** Send the visitor to Whop to sign in; `keep` survives the round trip (e.g. a device code). */
export async function signIn(keep: Record<string, string> = {}): Promise<void> {
  const p = { verifier: rand(32), state: rand(16), nonce: rand(16), keep };
  write(sessionStorage, PKCE, p);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: "openid profile email",
    state: p.state,
    nonce: p.nonce,
    code_challenge: await sha256(p.verifier),
    code_challenge_method: "S256",
  });
  location.href = `https://api.whop.com/oauth/authorize?${q}`;
}

/** On the way back from Whop: exchange the code. Returns what signIn() kept, or null when this isn't a callback. */
export async function finishSignIn(): Promise<Record<string, string> | null> {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const state = q.get("state");
  if (!code && !q.get("error")) return null;
  const p = read<{ verifier: string; state: string; keep: Record<string, string> }>(sessionStorage, PKCE);
  write(sessionStorage, PKCE, null);
  history.replaceState(null, "", location.pathname);
  if (q.get("error")) throw new Error(q.get("error_description") ?? "Sign-in was cancelled.");
  if (!p || p.state !== state) throw new Error("Sign-in expired. Try again.");
  const r = await fetch("/api/v1/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: p.verifier, redirect_uri: redirectUri() }),
  });
  const t = (await r.json()) as {
    ok: boolean;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.ok || !t.access_token) throw new Error("Sign-in didn't complete. Try again.");
  save(t);
  return p.keep;
}

function save(t: { access_token?: string; refresh_token?: string; expires_in?: number }): void {
  write(localStorage, KEY, {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  });
}

export const signedIn = () => read<Tokens>(localStorage, KEY) !== null;

async function token(): Promise<string | null> {
  const t = read<Tokens>(localStorage, KEY);
  if (!t) return null;
  if (Date.now() < t.expires_at - 120_000) return t.access_token;
  const r = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: t.refresh_token }),
  }).catch(() => null);
  const n = (await r?.json().catch(() => null)) as { ok?: boolean; access_token?: string } | null;
  if (!n?.ok || !n.access_token) {
    write(localStorage, KEY, null);
    return null;
  }
  save(n);
  return n.access_token;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  [k: string]: unknown;
}

/** Call the account API as the signed-in user. 401 signs out. */
export async function api(path: string, body?: unknown): Promise<ApiResult> {
  const t = await token();
  if (!t) return { ok: false, status: 401, code: "signed_out" };
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${t}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const d = (await r.json().catch(() => ({ ok: false, message: "No answer. Try again." }))) as ApiResult;
  if (r.status === 401) write(localStorage, KEY, null);
  return { ...d, status: r.status };
}

export async function signOut(): Promise<void> {
  const t = read<Tokens>(localStorage, KEY);
  write(localStorage, KEY, null);
  if (t?.refresh_token)
    await fetch("/api/v1/auth/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: t.refresh_token }),
    }).catch(() => undefined);
}

/** Tiny DOM helper: h("p", {class: "x"}, "text", child) */
export function h(
  tag: string,
  attrs: Record<string, string> = {},
  ...kids: (Node | string | null)[]
): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}
