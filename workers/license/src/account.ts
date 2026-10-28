import { type Env, type Fetch, fail, json, type Membership, planOf, refusal, VALID, whop } from "./common.ts";

/**
 * Savant accounts (ADR-093). The account is the customer's Whop account (the one that bought the plan), so there is
 * one login and no email matching. getsavant.pro signs people in with Whop (OAuth 2.1 + PKCE, public client) and calls
 * these endpoints with the Whop access token; this Worker checks it against Whop's userinfo and then acts with the
 * seller API key, only ever on memberships that belong to that user.
 *
 *   POST /v1/auth/token    {code, code_verifier, redirect_uri}   → Whop tokens (the code exchange, proxied)
 *   POST /v1/auth/refresh  {refresh_token}                       → fresh tokens
 *   POST /v1/auth/revoke   {token}                               → sign out
 *   GET  /v1/account                                              → the user, their Savant plans and devices
 *   POST /v1/account/cancel       {membership}                    → cancel at the end of the paid period
 *   POST /v1/account/undo-cancel  {membership}                    → keep the subscription after all
 *   POST /v1/account/deactivate   {membership}                    → free the licence from its computer
 *   POST /v1/device/start  {machine, name}  (the app)            → {user_code, verify_url, device_secret}
 *   GET  /v1/device/info?code=              (signed in)           → which computer is asking
 *   POST /v1/device/approve {code, move?}   (signed in)           → binds the licence to that computer
 *   POST /v1/device/poll   {device_secret}  (the app)            → pending | approved {key} | expired
 *
 * Device sign-in is the OAuth device-authorization pattern: the app shows a short code and opens
 * getsavant.pro/activate; the user signs in there and approves; the app picks up its licence key and activates it
 * through the normal /v1/activate path. A licence lives on one computer at a time: approving on a new computer moves
 * it, and the old one drops its licence at its next check (within 3 hours while it is online).
 */

const OAUTH = (env: Env) =>
  (env as { WHOP_OAUTH_BASE?: string }).WHOP_OAUTH_BASE ?? "https://api.whop.com/oauth";
const DEVICE_TTL_S = 900;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

interface User {
  id: string;
  name: string | null;
  email: string | null;
}

const cache = new Map<string, { user: User; until: number }>();

async function sha(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function random(n: number, alphabet?: string): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  if (!alphabet) return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
}

/** Who is calling: the Whop user behind the bearer token (cached for 5 minutes per token). */
async function signedIn(request: Request, env: Env, f: Fetch): Promise<User | Response> {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token.length < 20) return fail("signed_out", "Sign in first.", 401);
  const k = await sha(token);
  const hit = cache.get(k);
  if (hit && hit.until > Date.now()) return hit.user;
  const r = await f(`${OAUTH(env)}/userinfo`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 401 || r.status === 403)
    return fail("signed_out", "Your sign-in expired. Sign in again.", 401);
  if (!r.ok) return fail("upstream", "Whop didn't answer. Try again in a minute.", 502);
  const u = (await r.json()) as { sub?: string; name?: string; preferred_username?: string; email?: string };
  if (!u.sub?.startsWith("user_")) return fail("signed_out", "Sign in again.", 401);
  const user = { id: u.sub, name: u.name ?? u.preferred_username ?? null, email: u.email ?? null };
  if (cache.size > 5_000) cache.clear();
  cache.set(k, { user, until: Date.now() + 5 * 60_000 });
  return user;
}

/** The user's memberships of the Savant product (seller key, filtered to this user). */
async function memberships(env: Env, f: Fetch, user: User): Promise<Membership[] | Response> {
  const q = new URLSearchParams({ user_id: user.id, first: "20" });
  if (env.WHOP_ACCOUNT_ID) q.set("account_id", env.WHOP_ACCOUNT_ID);
  for (const p of (env.WHOP_PRODUCT_IDS ?? "").split(",").filter(Boolean)) q.append("product_ids", p.trim());
  const r = await whop(env, f, "GET", `/memberships?${q}`);
  if (!r.ok) return fail("upstream", "Couldn't load your plans right now. Try again in a minute.", 502);
  const d = (await r.json()) as { data?: Membership[] };
  return (d.data ?? []).filter((m) => !m.user_id || m.user_id === user.id);
}

/** The membership that should carry the licence: a paid, current plan (active before trial before grace). */
function best(env: Env, list: Membership[]): Membership | null {
  const rank: Record<string, number> = { active: 0, trialing: 1, past_due: 2, completed: 3 };
  return (
    list
      .filter((m) => VALID.has(m.status) && refusal(env, m) === null)
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0] ?? null
  );
}

type Body = Record<string, unknown>;
const str = (b: Body, k: string, max = 300) =>
  typeof b[k] === "string" ? (b[k] as string).slice(0, max) : "";

function view(env: Env, m: Membership) {
  const md = m.metadata ?? {};
  const days = (m as { billing_period_days?: number | null }).billing_period_days ?? null;
  const paid = refusal(env, m) === null;
  return {
    id: m.id,
    plan: !paid
      ? "Free demo"
      : days === 365
        ? "Yearly"
        : days === 30
          ? "Monthly"
          : (m.product?.title ?? "Savant"),
    paid,
    status: m.status,
    trial: m.status === "trialing",
    renews_at: m.current_period_end ?? null,
    cancel_at_period_end: Boolean(m.cancel_at_period_end),
    manage_url: m.manage_url ?? null,
    license_key: paid ? (m.license_key ?? null) : null,
    device:
      typeof md.hwid === "string" && md.hwid
        ? {
            name: typeof md.device_name === "string" ? md.device_name : "A computer",
            activated_at: typeof md.activated_at === "string" ? md.activated_at : null,
            last_seen: typeof md.last_seen === "string" ? md.last_seen : null,
          }
        : null,
    plan_id: planOf(m),
  };
}

async function owned(env: Env, f: Fetch, user: User, id: string): Promise<Membership | Response> {
  const list = await memberships(env, f, user);
  if (list instanceof Response) return list;
  const m = list.find((x) => x.id === id);
  return m ?? fail("not_found", "That plan isn't on your account.", 404);
}

export async function accountRoutes(request: Request, env: Env, f: Fetch, url: URL): Promise<Response> {
  const p = url.pathname;
  const ip = request.headers.get("cf-connecting-ip") ?? "?";
  // polling is a KV read keyed by a 256-bit secret: not rate limited (it runs every few seconds while signing in)
  if (p !== "/v1/device/poll" && env.RL && !(await env.RL.limit({ key: `acct:${ip}` })).success)
    return fail("rate_limited", "Too many requests. Wait a minute and try again.", 429);
  let body: Body = {};
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > 4_000) return fail("bad_request", "Request too large.", 413);
    try {
      body = raw ? (JSON.parse(raw) as Body) : {};
    } catch {
      return fail("bad_request", "Bad JSON.");
    }
  }
  const site = (env.SITE_ORIGIN ?? "https://getsavant.pro").replace(/\/$/, "");
  const clientId = env.WHOP_OAUTH_CLIENT_ID ?? "";

  // ---- the OAuth code exchange and refresh, proxied so the site's CSP stays 'self'
  if (p === "/v1/auth/token" || p === "/v1/auth/refresh") {
    if (!clientId) return fail("not_configured", "Sign-in isn't set up yet.", 503);
    const redirect = str(body, "redirect_uri");
    if (p === "/v1/auth/token" && !redirect.startsWith(`${site}/`))
      return fail("bad_request", "Unknown redirect address.");
    const payload =
      p === "/v1/auth/token"
        ? {
            grant_type: "authorization_code",
            code: str(body, "code", 500),
            code_verifier: str(body, "code_verifier", 200),
            redirect_uri: redirect,
            client_id: clientId,
          }
        : {
            grant_type: "refresh_token",
            refresh_token: str(body, "refresh_token", 2_000),
            client_id: clientId,
          };
    const r = await f(`${OAUTH(env)}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const t = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) return fail("signed_out", "Sign-in didn't complete. Try again.", 401);
    return json({
      ok: true,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_in: t.expires_in,
    });
  }
  if (p === "/v1/auth/revoke") {
    if (clientId && str(body, "token", 2_000))
      await f(`${OAUTH(env)}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: str(body, "token", 2_000), client_id: clientId }),
      }).catch(() => undefined);
    return json({ ok: true });
  }

  // ---- the app starts a device sign-in (no user yet)
  if (p === "/v1/device/start" && request.method === "POST") {
    if (!env.DEVICES) return fail("not_configured", "Device sign-in isn't set up yet.", 503);
    const machine = str(body, "machine", 64);
    if (!/^[0-9a-f]{32,64}$/.test(machine)) return fail("bad_request", "Send a machine id.");
    const code = `${random(4, CODE_ALPHABET)}-${random(4, CODE_ALPHABET)}`;
    const secret = random(32);
    const rec = {
      machine,
      name: str(body, "name", 60) || "A computer",
      secret: await sha(secret),
      status: "pending",
    };
    await env.DEVICES.put(`code:${code}`, JSON.stringify(rec), { expirationTtl: DEVICE_TTL_S });
    await env.DEVICES.put(`secret:${rec.secret}`, code, { expirationTtl: DEVICE_TTL_S });
    return json({
      ok: true,
      user_code: code,
      verify_url: `${site}/activate/?code=${code}`,
      device_secret: secret,
      interval: 4,
      expires_in: DEVICE_TTL_S,
    });
  }
  if (p === "/v1/device/poll" && request.method === "POST") {
    if (!env.DEVICES) return fail("not_configured", "Device sign-in isn't set up yet.", 503);
    const h = await sha(str(body, "device_secret", 100));
    const code = await env.DEVICES.get(`secret:${h}`);
    const rec = code ? (JSON.parse((await env.DEVICES.get(`code:${code}`)) ?? "null") as Body | null) : null;
    if (!code || !rec) return json({ ok: true, status: "expired" });
    if (rec.status !== "approved") return json({ ok: true, status: "pending" });
    await env.DEVICES.delete(`code:${code}`);
    await env.DEVICES.delete(`secret:${h}`);
    return json({ ok: true, status: "approved", key: rec.key, plan: rec.plan });
  }

  // ---- everything below needs a signed-in customer
  const user = await signedIn(request, env, f);
  if (user instanceof Response) return user;

  if (p === "/v1/account" && request.method === "GET") {
    const list = await memberships(env, f, user);
    if (list instanceof Response) return list;
    return json({ ok: true, user, plans: list.map((m) => view(env, m)) });
  }
  if (p === "/v1/account/cancel" || p === "/v1/account/undo-cancel" || p === "/v1/account/deactivate") {
    const m = await owned(env, f, user, str(body, "membership", 60));
    if (m instanceof Response) return m;
    const patch =
      p === "/v1/account/deactivate"
        ? { metadata: { ...m.metadata, hwid: null, device_name: null } }
        : { cancel_at_period_end: p === "/v1/account/cancel" };
    const r = await whop(env, f, "PATCH", `/memberships/${m.id}`, patch);
    if (!r.ok)
      return fail("upstream", "Whop didn't accept the change. Try again, or use Manage billing.", 502);
    return json({
      ok: true,
      message:
        p === "/v1/account/deactivate"
          ? "That computer no longer holds the licence. It stops opening new trades at its next check."
          : p === "/v1/account/cancel"
            ? "Cancelled. You keep everything until the end of the paid period, and you won't be charged again."
            : "Your subscription will renew as usual.",
    });
  }
  if (p === "/v1/device/info" || p === "/v1/device/approve") {
    if (!env.DEVICES) return fail("not_configured", "Device sign-in isn't set up yet.", 503);
    const code = (p === "/v1/device/info" ? (url.searchParams.get("code") ?? "") : str(body, "code", 20))
      .toUpperCase()
      .trim();
    const rec = JSON.parse((await env.DEVICES.get(`code:${code}`)) ?? "null") as Body | null;
    if (!rec) return fail("expired", "That code has expired. Start sign-in again from the Savant app.", 404);
    const list = await memberships(env, f, user);
    if (list instanceof Response) return list;
    const m = best(env, list);
    if (!m)
      return fail(
        "no_subscription",
        "Your Whop account has no Savant plan yet. Start the 7-day free trial, then come back to this page.",
        402,
      );
    const bound =
      typeof m.metadata?.hwid === "string" && m.metadata.hwid ? (m.metadata.hwid as string) : null;
    const elsewhere =
      bound && bound !== rec.machine ? String(m.metadata?.device_name ?? "another computer") : null;
    if (p === "/v1/device/info")
      return json({ ok: true, device: rec.name, plan: view(env, m).plan, elsewhere, status: rec.status });
    if (elsewhere && body.move !== true)
      return json(
        { ok: false, code: "bound_elsewhere", message: `Savant is active on ${elsewhere}.`, elsewhere },
        409,
      );
    if (!m.license_key)
      return fail(
        "not_configured",
        "This plan has no licence key yet. Contact support from your Whop account.",
        500,
      );
    const now = new Date().toISOString();
    const r = await whop(env, f, "PATCH", `/memberships/${m.id}`, {
      metadata: {
        ...m.metadata,
        hwid: rec.machine,
        device_name: rec.name,
        activated_at: now,
        last_seen: now,
      },
    });
    if (!r.ok) return fail("upstream", "Whop didn't accept the change. Try again in a minute.", 502);
    await env.DEVICES.put(
      `code:${code}`,
      JSON.stringify({ ...rec, status: "approved", key: m.license_key, plan: view(env, m).plan }),
      { expirationTtl: DEVICE_TTL_S },
    );
    return json({
      ok: true,
      message: elsewhere
        ? `Moved to ${String(rec.name)}. ${elsewhere} stops opening new trades at its next check.`
        : `${String(rec.name)} is signed in. You can close this page.`,
    });
  }
  return fail("not_found", "Not found.", 404);
}
