/**
 * Web-terminal tokens (ADR-034). A `/terminal` Discord command (operator-only, signature-verified) mints a
 * single-use login token valid for 10 minutes; the page trades it for an HttpOnly session cookie valid for
 * 12 hours. Both are `base64url(json).base64url(hmac-sha256)` with WEB_SESSION_SECRET.
 */

export type TokenKind = "login" | "session";
export interface TokenPayload {
  k: TokenKind;
  exp: number; // epoch ms
  n: string; // nonce (login tokens are single-use by nonce)
}

export const LOGIN_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 12 * 3_600_000;
export const SESSION_COOKIE = "c54s";

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function mac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export async function signToken(secret: string, p: TokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)));
  return `${body}.${b64url(await mac(secret, body))}`;
}

export async function verifyToken(
  secret: string,
  token: string | null | undefined,
  kind: TokenKind,
  now: number,
): Promise<TokenPayload | null> {
  if (!secret || !token || token.length > 1000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const got = fromB64url(sig);
  if (!got || !equal(got, await mac(secret, body))) return null;
  const raw = fromB64url(body);
  if (!raw) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(raw)) as TokenPayload;
    if (p.k !== kind || typeof p.exp !== "number" || p.exp < now || typeof p.n !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function sessionCookie(token: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}
