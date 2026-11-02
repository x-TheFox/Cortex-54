/**
 * Pre-release audit: a local Whop stand-in + the REAL licence server code, for end-to-end licence and sign-in tests
 * without real money (docs/audit/HARNESS.md §licence). Point it at the real Whop sandbox instead with WHOP_SANDBOX=1
 * (then WHOP_API_KEY must be a sandbox key and the OAuth app a sandbox app).
 *
 *   pnpm exec tsx scripts/audit/whop-standin.ts            # stand-in on :8790, licence server on :8791
 *
 * Stand-in (:8790)
 *   GET/PATCH /api/v1/memberships/:id|:license_key, GET /api/v1/memberships?user_id=…
 *   GET /oauth/authorize  → signs the test buyer in at once and redirects back with code + state
 *   POST /oauth/token, GET /oauth/userinfo, POST /oauth/revoke
 *   POST /admin/membership {id, …fields}  → change a membership (refund = status canceled, trial, past_due, plan …)
 *   GET  /admin/state
 * Licence server (:8791): workers/license/src/index.ts `handle()` with an in-memory DEVICES store and a fresh
 * publisher key; its public key is written to docs/audit/runs/licence-pubkey.txt for the app build.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { publisherKeygen } from "../../local/license.ts";
import type { DeviceStore, Env } from "../../workers/license/src/common.ts";
import { handle } from "../../workers/license/src/index.ts";

const WHOP = 8790;
const LIC = 8791;
const SITE = process.env.SITE_ORIGIN ?? "http://localhost:5176";
const sandbox = process.env.WHOP_SANDBOX === "1";

const PROD = "prod_sdzK9Kr4E2Kgz";
const MONTHLY = "plan_4bBHwmIccRi3d";
const YEARLY = "plan_1uDX0TPE2wKea";
const FREE = "plan_YlojATUwHM5Um";

interface M {
  id: string;
  status: string;
  user_id: string;
  product_id: string;
  product: { id: string; title: string };
  plan_id: string;
  license_key: string;
  metadata: Record<string, unknown>;
  cancel_at_period_end: boolean;
  current_period_end: string;
  expires_at: string | null;
  billing_period_days: number;
  manage_url: string;
}
const day = 86_400_000;
const mem = (id: string, user: string, status: string, plan: string, days = 30): M => ({
  id,
  status,
  user_id: user,
  product_id: PROD,
  product: { id: PROD, title: "Savant" },
  plan_id: plan,
  license_key: `K-${id.toUpperCase()}`,
  metadata: {},
  cancel_at_period_end: false,
  current_period_end: new Date(Date.now() + days * day).toISOString(),
  expires_at: null,
  billing_period_days: plan === YEARLY ? 365 : 30,
  manage_url: "https://whop.com/orders",
});
/** Test buyers (plus-addressed, never real cards). */
const users: Record<string, { sub: string; email: string; name: string }> = {
  user_audit1: { sub: "user_audit1", email: "buyer+audit1@example.test", name: "Audit Buyer 1" },
  user_audit2: { sub: "user_audit2", email: "buyer+audit2@example.test", name: "Audit Buyer 2" },
  user_audit3: { sub: "user_audit3", email: "buyer+audit3@example.test", name: "Audit Free" },
};
const memberships: Record<string, M> = {
  mem_trial1: mem("mem_trial1", "user_audit1", "trialing", MONTHLY, 7),
  mem_year2: mem("mem_year2", "user_audit2", "active", YEARLY, 365),
  mem_free3: mem("mem_free3", "user_audit3", "active", FREE),
};
let signInAs = "user_audit1";
const codes = new Map<string, string>(); // oauth code → user
const tokens = new Map<string, string>(); // access token → user

const body = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });
const send = (res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof v === "string" ? v : JSON.stringify(v));
};

const log: string[] = [];
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${WHOP}`);
  const p = url.pathname;
  log.push(`${new Date().toISOString()} ${req.method} ${p}`);
  if (p === "/admin/state") return send(res, 200, { memberships, signInAs, log: log.slice(-40) });
  if (p === "/admin/membership" && req.method === "POST") {
    const b = JSON.parse(await body(req)) as Partial<M> & { id: string; signInAs?: string };
    if (b.signInAs) signInAs = b.signInAs;
    if (b.id) {
      const m = memberships[b.id] ?? mem(b.id, b.user_id ?? "user_audit1", "active", MONTHLY);
      memberships[b.id] = { ...m, ...b, metadata: { ...m.metadata, ...(b.metadata ?? {}) } };
    }
    return send(res, 200, { ok: true, m: b.id ? memberships[b.id] : null, signInAs });
  }
  if (p === "/oauth/authorize") {
    const code = `code_${Math.random().toString(36).slice(2)}`;
    codes.set(code, signInAs);
    const back = new URL(url.searchParams.get("redirect_uri") ?? SITE);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (p === "/oauth/token" && req.method === "POST") {
    const b = JSON.parse(await body(req)) as { code?: string; grant_type: string; refresh_token?: string };
    const user =
      b.grant_type === "refresh_token" ? (b.refresh_token ?? "").replace(/^r_/, "") : codes.get(b.code ?? "");
    if (!user) return send(res, 400, { error: "invalid_grant" });
    const t = `tok_${user}_${Math.random().toString(36).slice(2)}xxxxxxxx`;
    tokens.set(t, user);
    return send(res, 200, { access_token: t, refresh_token: `r_${user}`, expires_in: 3600 });
  }
  if (p === "/oauth/userinfo") {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const u = tokens.get(t);
    return u ? send(res, 200, users[u] ?? { sub: u }) : send(res, 401, { error: "invalid_token" });
  }
  if (p === "/oauth/revoke") {
    const b = JSON.parse((await body(req)) || "{}") as { token?: string };
    if (b.token) tokens.delete(b.token);
    return send(res, 200, {});
  }
  const m = /^\/api\/v1\/memberships\/([^/]+)$/.exec(p);
  if (m) {
    const k = decodeURIComponent(m[1] as string);
    const x = memberships[k] ?? Object.values(memberships).find((y) => y.license_key === k);
    if (!x) return send(res, 404, { error: "not found" });
    if (req.method === "PATCH") {
      const b = JSON.parse(await body(req)) as Partial<M>;
      Object.assign(x, b);
    }
    return send(res, 200, x);
  }
  if (p === "/api/v1/memberships") {
    const u = url.searchParams.get("user_id");
    return send(res, 200, { data: Object.values(memberships).filter((x) => x.user_id === u) });
  }
  send(res, 404, { error: "stand-in: not found" });
}).listen(WHOP, "127.0.0.1");

// ---- the real licence server code
const kv = new Map<string, { v: string; until: number }>();
const DEVICES: DeviceStore = {
  async get(k) {
    const x = kv.get(k);
    return x && x.until > Date.now() ? x.v : null;
  },
  async put(k, v, o) {
    kv.set(k, { v, until: Date.now() + (o?.expirationTtl ?? 3600) * 1000 });
  },
  async delete(k) {
    kv.delete(k);
  },
};
const keys = publisherKeygen();
mkdirSync("docs/audit/runs", { recursive: true });
writeFileSync("docs/audit/runs/licence-pubkey.txt", keys.publicKeyB64);
const env: Env & { WHOP_OAUTH_BASE?: string } = {
  WHOP_API_KEY: sandbox ? (process.env.WHOP_API_KEY ?? "") : "standin-key",
  LICENSE_SIGNING_KEY: keys.privateKeyPem,
  WHOP_PRODUCT_IDS: process.env.WHOP_PRODUCT_IDS ?? PROD,
  WHOP_PAID_PLAN_IDS: process.env.WHOP_PAID_PLAN_IDS ?? `${MONTHLY},${YEARLY}`,
  WHOP_API_BASE: sandbox ? "https://sandbox-api.whop.com/api/v1" : `http://127.0.0.1:${WHOP}/api/v1`,
  WHOP_OAUTH_BASE: sandbox ? "https://sandbox-api.whop.com/oauth" : `http://127.0.0.1:${WHOP}/oauth`,
  WHOP_OAUTH_CLIENT_ID: process.env.WHOP_OAUTH_CLIENT_ID ?? "app_audit_standin",
  SITE_ORIGIN: SITE,
  DEVICES,
};
createServer(async (req, res) => {
  const b = req.method === "POST" ? await body(req) : undefined;
  const init: RequestInit = { method: req.method ?? "GET", headers: req.headers as Record<string, string> };
  if (b !== undefined) init.body = b;
  const r = await handle(new Request(`http://127.0.0.1:${LIC}${req.url}`, init), env);
  res.writeHead(r.status, {
    "content-type": r.headers.get("content-type") ?? "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(await r.text());
}).listen(LIC, "127.0.0.1");
console.log(`whop stand-in :${WHOP} (sandbox=${sandbox}) · licence server :${LIC} · site ${SITE}`);
