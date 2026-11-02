import type { ActivateResponse } from "../../../src/license/format.ts";

/** Shared by the licence and account endpoints (ADR-086, ADR-093). */

/** The slice of Workers KV the device sign-in uses (so tests can pass a Map-backed fake). */
export interface DeviceStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, o?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface Env {
  WHOP_API_KEY: string;
  /** Ed25519 private key, PKCS#8 PEM (the publisher licence key, scripts/license.ts keygen) */
  LICENSE_SIGNING_KEY: string;
  /** optional: the key for device credentials (audit LIC-05); defaults to a key derived from the signing key */
  DEVICE_CREDENTIAL_SECRET?: string;
  /** only memberships of these products count (comma-separated prod_ ids); empty = any product of the account */
  WHOP_PRODUCT_IDS?: string;
  /** only memberships on these plans unlock trading (comma-separated plan_ ids); empty = any plan. The free demo plan
   * is a Whop membership too, so production lists only the paid (monthly, yearly) plans. */
  WHOP_PAID_PLAN_IDS?: string;
  WHOP_API_BASE?: string;
  /** ADR-093: Sign in with Whop (OAuth app id, public PKCE client) and where the account pages live */
  WHOP_OAUTH_CLIENT_ID?: string;
  WHOP_ACCOUNT_ID?: string;
  SITE_ORIGIN?: string;
  /** ADR-093: short-lived device sign-in codes (KV, TTL'd) */
  DEVICES?: DeviceStore;
  /** Workers rate-limiting binding (optional; wrangler.jsonc) */
  RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export const TOKEN_DAYS = 14;
export const REFRESH_HOURS = 24;
export const VALID = new Set(["active", "trialing", "completed", "past_due"]); // past_due: Whop's retry grace period

export type Fetch = (u: string, i?: RequestInit) => Promise<Response>;

export interface Membership {
  id: string;
  status: string;
  product_id?: string;
  product?: { id: string; title: string };
  /** Whop's current field for the plan (variant) bought; plan_id/plan are older shapes */
  variant_id?: string;
  plan_id?: string;
  plan?: { id: string } | null;
  license_key?: string | null;
  cancel_at_period_end?: boolean;
  manage_url?: string | null;
  metadata?: Record<string, unknown>;
  user_id?: string | null;
  current_period_end?: string | null;
  expires_at?: string | null;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });

export const fail = (code: string, message: string, status = 400) =>
  json({ ok: false, code, message } satisfies ActivateResponse, status);

export async function whop(
  env: Env,
  f: Fetch,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return f(`${(env.WHOP_API_BASE ?? "https://api.whop.com/api/v1").replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.WHOP_API_KEY}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The plan a membership is on, whichever field Whop sent it in. */
export const planOf = (m: Membership) => m.variant_id ?? m.plan_id ?? m.plan?.id ?? "";

/** Wrong product or a free (demo) plan: the reason, or null when the membership may unlock trading. */
export function refusal(env: Env, m: Membership): Response | null {
  const allowed = list(env.WHOP_PRODUCT_IDS);
  const product = m.product_id ?? m.product?.id ?? "";
  if (allowed.length && !allowed.includes(product))
    return fail("wrong_product", "That key belongs to a different product.", 403);
  const paid = list(env.WHOP_PAID_PLAN_IDS);
  if (paid.length && !paid.includes(planOf(m)))
    return fail(
      "free_plan",
      "That key is for the free demo, which runs without a licence. Start the 7-day trial or a subscription to trade a real account.",
      403,
    );
  return null;
}

// ---- audit LIC-04: computers removed from an account stay removed -------------------------------------------------

/** Machine ids the customer removed (account page, or a move to another computer); never re-bound by first use. */
export const revokedOf = (m: Membership): string[] =>
  Array.isArray(m.metadata?.revoked_hwids)
    ? (m.metadata.revoked_hwids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

/** Metadata with `hwid` added to the removed list (newest 20 kept) and the binding cleared. */
export function revokeMachine(m: Membership, hwid: string | null): Record<string, unknown> {
  const list = hwid ? [hwid, ...revokedOf(m).filter((x) => x !== hwid)].slice(0, 20) : revokedOf(m);
  return { ...m.metadata, hwid: null, device_name: null, revoked_hwids: list };
}

// ---- audit LIC-05: device sign-in hands the app a credential bound to its machine, never the licence key ----------

async function hmac(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
}

const credSecret = (env: Env) => env.DEVICE_CREDENTIAL_SECRET ?? env.LICENSE_SIGNING_KEY;

/** `dk.<membership>.<mac>`: works only together with the machine id it was issued for. */
export async function deviceCredential(env: Env, membership: string, machine: string): Promise<string> {
  return `dk.${membership}.${(await hmac(credSecret(env), `${membership}:${machine}`)).slice(0, 40)}`;
}

/** The membership a device credential stands for, or null when it doesn't match this machine. */
export async function checkDeviceCredential(env: Env, cred: string, machine: string): Promise<string | null> {
  const m = /^dk\.([A-Za-z0-9_]{4,60})\.([0-9a-f]{40})$/.exec(cred);
  if (!m) return null;
  const want = (await hmac(credSecret(env), `${m[1]}:${machine}`)).slice(0, 40);
  let diff = 0;
  for (let i = 0; i < 40; i++) diff |= want.charCodeAt(i) ^ (m[2] as string).charCodeAt(i);
  return diff === 0 ? (m[1] as string) : null;
}
