import {
  ActivateRequestSchema,
  type ActivateResponse,
  LICENSE_KIND,
  type License,
  type LicenseBody,
  licenseBody,
} from "../../../src/license/format.ts";

/**
 * Savant licence server (ADR-086). The one place a Whop API key lives: the desktop app never holds it.
 *
 *   POST /v1/activate {key, machine, app?}  → checks the Whop licence key, binds it to this machine (first use),
 *                                             returns a v2 licence token signed with the publisher key
 *   POST /v1/release  {key, machine}        → frees the binding (moving to a new computer), only from the bound machine
 *   GET  /v1/health                         → {ok}
 *
 * Tokens last 14 days and the app refreshes them daily, so a refund or cancellation reaches the app within a day while
 * it is online, and a customer can work offline for up to two weeks. Binding follows Whop's documented pattern
 * (membership metadata `hwid`); customers can also reset it themselves from their Whop orders.
 */

export interface Env {
  WHOP_API_KEY: string;
  /** Ed25519 private key, PKCS#8 PEM (the publisher licence key, scripts/license.ts keygen) */
  LICENSE_SIGNING_KEY: string;
  /** only memberships of these products count (comma-separated prod_ ids); empty = any product of the account */
  WHOP_PRODUCT_IDS?: string;
  WHOP_API_BASE?: string;
  /** Workers rate-limiting binding (optional; wrangler.jsonc) */
  RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const TOKEN_DAYS = 14;
const REFRESH_HOURS = 24;
const VALID = new Set(["active", "trialing", "completed", "past_due"]); // past_due: Whop's retry grace period

type Fetch = (u: string, i?: RequestInit) => Promise<Response>;

interface Membership {
  id: string;
  status: string;
  product_id?: string;
  product?: { id: string; title: string };
  plan_id?: string;
  metadata?: Record<string, unknown>;
  user_id?: string | null;
  current_period_end?: string | null;
  expires_at?: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });

const fail = (code: string, message: string, status = 400) =>
  json({ ok: false, code, message } satisfies ActivateResponse, status);

async function whop(env: Env, f: Fetch, method: string, path: string, body?: unknown): Promise<Response> {
  return f(`${(env.WHOP_API_BASE ?? "https://api.whop.com/api/v1").replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.WHOP_API_KEY}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** PEM (PKCS#8) → CryptoKey for Ed25519 signing. */
async function signingKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

export async function signToken(body: LicenseBody, pem: string): Promise<License> {
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      await signingKey(pem),
      new TextEncoder().encode(licenseBody(body)),
    ),
  );
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return { ...body, sig: btoa(s) } as License;
}

async function lookup(env: Env, f: Fetch, key: string): Promise<Membership | Response> {
  const r = await whop(env, f, "GET", `/memberships/${encodeURIComponent(key)}`);
  if (r.status === 404)
    return fail("unknown_key", "That licence key wasn't found. Copy it again from your Whop orders.", 404);
  if (!r.ok)
    return fail("upstream", "The licence check is unavailable right now. Try again in a few minutes.", 502);
  const m = (await r.json()) as Membership;
  const allowed = (env.WHOP_PRODUCT_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const product = m.product_id ?? m.product?.id ?? "";
  if (allowed.length && !allowed.includes(product))
    return fail("wrong_product", "That key belongs to a different product.", 403);
  return m;
}

export async function handle(
  request: Request,
  env: Env,
  f: Fetch = (u, i) => fetch(u, i),
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS")
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, GET",
        "access-control-allow-headers": "content-type",
      },
    });
  if (url.pathname === "/v1/health") return json({ ok: true, name: "Savant licence server" });
  if (request.method !== "POST" || !["/v1/activate", "/v1/release"].includes(url.pathname))
    return fail("not_found", "Not found.", 404);
  const raw = await request.text();
  if (raw.length > 2_000) return fail("bad_request", "Request too large.", 413);
  const parsed = ActivateRequestSchema.safeParse(
    (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success) return fail("bad_request", "Send a licence key and a machine id.");
  const { key, machine } = parsed.data;
  // rate limits: per key (guessing keys is pointless anyway) and per client address
  const ip = request.headers.get("cf-connecting-ip") ?? "?";
  if (env.RL) {
    const [a, b] = await Promise.all([
      env.RL.limit({ key: `ip:${ip}` }),
      env.RL.limit({ key: `key:${key}` }),
    ]);
    if (!a.success || !b.success)
      return fail("rate_limited", "Too many attempts. Wait a minute and try again.", 429);
  }

  const m = await lookup(env, f, key);
  if (m instanceof Response) return m;
  const bound = typeof m.metadata?.hwid === "string" ? (m.metadata.hwid as string) : null;

  if (url.pathname === "/v1/release") {
    if (bound && bound !== machine)
      return fail("bound_to_another_machine", "Only the computer this key is active on can release it.", 409);
    if (bound) {
      const r = await whop(env, f, "PATCH", `/memberships/${m.id}`, {
        metadata: { ...m.metadata, hwid: null },
      });
      if (!r.ok)
        return fail("upstream", "Couldn't release the key right now. Try again in a few minutes.", 502);
    }
    return json({ ok: true, message: "Released. You can activate the key on another computer now." });
  }

  if (!VALID.has(m.status))
    return fail(
      "membership_inactive",
      `This licence is ${m.status === "canceled" || m.status === "expired" ? "no longer active" : `not active (${m.status})`}. Renew it on Whop to keep trading; demo mode still works.`,
      403,
    );
  if (bound && bound !== machine)
    return fail(
      "bound_to_another_machine",
      "This key is active on another computer. Release it there (Settings → Licence), or reset it from your Whop orders.",
      409,
    );
  if (!bound) {
    const r = await whop(env, f, "PATCH", `/memberships/${m.id}`, {
      metadata: { ...m.metadata, hwid: machine, activated_at: new Date().toISOString() },
    });
    if (!r.ok) return fail("upstream", "Couldn't activate right now. Try again in a few minutes.", 502);
  }

  const now = Date.now();
  // never past the paid period's end (+ a day of slack for renewal timing), never more than 14 days
  const periodEnd = Date.parse(m.expires_at ?? m.current_period_end ?? "");
  const cap = Number.isFinite(periodEnd) ? periodEnd + 86_400_000 : Number.POSITIVE_INFINITY;
  const expires = Math.min(now + TOKEN_DAYS * 86_400_000, cap);
  const body: LicenseBody = {
    kind: LICENSE_KIND,
    v: 2,
    id: m.id,
    licensee: m.user_id ?? "Whop customer",
    plan: (m.status === "trialing" ? "trial" : (m.product?.title ?? "Savant")).slice(0, 40),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(expires).toISOString(),
    machine,
    source: "whop",
    refresh_after: new Date(now + REFRESH_HOURS * 3_600_000).toISOString(),
  };
  const license = await signToken(body, env.LICENSE_SIGNING_KEY);
  return json({
    ok: true,
    license,
    message:
      m.status === "trialing" ? "Trial activated on this computer." : "Licence activated on this computer.",
  } satisfies ActivateResponse);
}

export default {
  fetch: (request: Request, env: Env) =>
    handle(request, env).catch(() => fail("internal", "Something went wrong. Try again in a minute.", 500)),
};
