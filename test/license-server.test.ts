import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateKey,
  checkLicense,
  pollDeviceSignIn,
  publisherKeygen,
  readLicense,
  refreshLicense,
  startDeviceSignIn,
} from "../local/license.ts";
import { machineId } from "../local/machine.ts";
import { handle } from "../workers/license/src/index.ts";

/**
 * ADR-086: the licence server against a fake Whop API, and the app's activation against the server. Real Ed25519 on
 * both sides (WebCrypto signs in the Worker, node:crypto verifies in the app), so a format drift fails here.
 */
const keys = publisherKeygen();

function fakeWhop(m: Record<string, unknown> | null) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const state = { m: m ? { ...m } : null };
  const f = async (u: string, i?: RequestInit) => {
    const path = new URL(u).pathname.replace(/^\/api\/v1/, "");
    const method = i?.method ?? "GET";
    const body = i?.body ? JSON.parse(String(i.body)) : undefined;
    calls.push({ method, path, body });
    if (!state.m) return new Response("{}", { status: 404 });
    if (method === "PATCH") {
      state.m.metadata = {
        ...((state.m.metadata as object) ?? {}),
        ...(body as { metadata: object }).metadata,
      };
      return Response.json(state.m);
    }
    return Response.json(state.m);
  };
  return { f, calls, state };
}

const env = (extra: Record<string, string> = {}) => ({
  WHOP_API_KEY: "test",
  LICENSE_SIGNING_KEY: keys.privateKeyPem,
  WHOP_PRODUCT_IDS: "prod_savant",
  ...extra,
});

const member = (status = "active", metadata: Record<string, unknown> = {}) => ({
  id: "mem_abc123",
  status,
  product_id: "prod_savant",
  product: { id: "prod_savant", title: "Savant" },
  user_id: "user_1",
  current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  metadata,
});

const post = (path: string, body: unknown) =>
  new Request(`https://lic.example${path}`, { method: "POST", body: JSON.stringify(body) });

const M1 = "a".repeat(40);
const M2 = "b".repeat(40);

describe("licence server (ADR-086)", () => {
  it("binds the first machine, signs a token the app accepts, and refuses a second machine", async () => {
    const w = fakeWhop(member());
    const r1 = (await (
      await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }), env(), w.f)
    ).json()) as {
      ok: boolean;
      license: unknown;
    };
    expect(r1.ok).toBe(true);
    expect((w.state.m?.metadata as { hwid?: string } | undefined)?.hwid).toBe(M1);
    expect(checkLicense(r1.license, keys.publicKeyB64, Date.now(), M1)).toMatchObject({ ok: true });
    expect(checkLicense(r1.license, keys.publicKeyB64, Date.now(), M2)).toMatchObject({ ok: false });
    const r2 = await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M2 }), env(), w.f);
    expect(r2.status).toBe(409);
    // release from the bound machine frees it
    expect(
      (await handle(post("/v1/release", { key: "KEY-1234-5678", machine: M2 }), env(), w.f)).status,
    ).toBe(409);
    expect(
      (await handle(post("/v1/release", { key: "KEY-1234-5678", machine: M1 }), env(), w.f)).status,
    ).toBe(200);
    expect(
      (await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M2 }), env(), w.f)).status,
    ).toBe(200);
  });

  it("refuses inactive, unknown and other-product keys; a trial says so; tokens never outlive the paid period", async () => {
    expect(
      (
        await handle(
          post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }),
          env(),
          fakeWhop(member("canceled")).f,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }), env(), fakeWhop(null).f))
        .status,
    ).toBe(404);
    const other = fakeWhop({
      ...member(),
      product_id: "prod_other",
      product: { id: "prod_other", title: "x" },
    });
    expect(
      (await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }), env(), other.f)).status,
    ).toBe(403);
    // the free demo plan is a membership too, but it never unlocks trading
    const paidOnly = env({ WHOP_PAID_PLAN_IDS: "plan_monthly,plan_yearly" });
    const demo = fakeWhop({ ...member(), plan: { id: "plan_free_demo" } });
    const refused = await handle(
      post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }),
      paidOnly,
      demo.f,
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("free_plan");
    const monthly = fakeWhop({ ...member(), plan: { id: "plan_monthly" } });
    expect(
      (await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }), paidOnly, monthly.f)).status,
    ).toBe(200);
    const soon = fakeWhop({
      ...member("trialing"),
      current_period_end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    const r = (await (
      await handle(post("/v1/activate", { key: "KEY-1234-5678", machine: M1 }), env(), soon.f)
    ).json()) as {
      license: { plan: string; expires_at: string };
    };
    expect(r.license.plan).toBe("trial");
    expect(Date.parse(r.license.expires_at)).toBeLessThan(Date.now() + 4 * 86_400_000);
    expect((await handle(post("/v1/activate", { key: "x", machine: "nothex" }), env(), soon.f)).status).toBe(
      400,
    );
  });

  it("the app activates, refreshes daily, keeps working offline, and drops a refunded licence", async () => {
    const home = mkdtempSync(join(tmpdir(), "savant-lic-"));
    const w = fakeWhop(member());
    const server = async (u: string, i?: RequestInit) => handle(new Request(u, i), env(), w.f);
    const a = await activateKey(home, "KEY-1234-5678", {
      server: "https://lic.example",
      fetcher: server,
      pubkey: keys.publicKeyB64,
    });
    expect(a.ok).toBe(true);
    expect((w.state.m?.metadata as { hwid?: string } | undefined)?.hwid).toBe(machineId(home));
    expect(readLicense(home, keys.publicKeyB64)).toMatchObject({ ok: true });
    expect(
      await refreshLicense(home, "KEY-1234-5678", {
        server: "https://lic.example",
        fetcher: server,
        pubkey: keys.publicKeyB64,
      }),
    ).toBe("fresh");
    const later = Date.now() + 2 * 86_400_000;
    const offline = async () => {
      throw new Error("offline");
    };
    expect(
      await refreshLicense(home, "KEY-1234-5678", {
        fetcher: offline,
        now: later,
        pubkey: keys.publicKeyB64,
      }),
    ).toBe("offline");
    expect(readLicense(home, keys.publicKeyB64)).toMatchObject({ ok: true }); // still within 14 days
    w.state.m = { ...(w.state.m as object), status: "canceled" } as never; // refunded
    expect(
      await refreshLicense(home, "KEY-1234-5678", {
        server: "https://lic.example",
        fetcher: server,
        now: later,
        pubkey: keys.publicKeyB64,
      }),
    ).toBe("revoked");
    expect(readLicense(home, keys.publicKeyB64)).toMatchObject({ ok: false });
  });
});

describe("Savant accounts and device sign-in (ADR-093)", () => {
  /** A fake Whop with OAuth (userinfo/token), a membership list and PATCH. */
  function whopWithUsers(members: Record<string, unknown>[]) {
    const ms = members.map((m) => ({ ...m }));
    const f = async (u: string, i?: RequestInit) => {
      const url = new URL(u);
      const method = i?.method ?? "GET";
      const body = i?.body ? JSON.parse(String(i.body)) : undefined;
      if (url.pathname === "/oauth/userinfo") {
        const t = new Headers(i?.headers).get("authorization");
        if (t === "Bearer token-of-alice-123456789")
          return Response.json({ sub: "user_alice", name: "Alice" });
        if (t === "Bearer token-of-bob-1234567890") return Response.json({ sub: "user_bob", name: "Bob" });
        return new Response("{}", { status: 401 });
      }
      if (url.pathname === "/oauth/token")
        return body.code === "good"
          ? Response.json({ access_token: "token-of-alice-123456789", refresh_token: "r", expires_in: 3600 })
          : new Response("{}", { status: 400 });
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (path === "/memberships" && method === "GET") {
        const uid = url.searchParams.get("user_id");
        return Response.json({ data: ms.filter((m) => m.user_id === uid) });
      }
      const m = ms.find((x) => path === `/memberships/${x.id}` || path === `/memberships/${x.license_key}`);
      if (!m) return new Response("{}", { status: 404 });
      if (method === "PATCH") {
        if (body.metadata) m.metadata = { ...((m.metadata as object) ?? {}), ...body.metadata };
        if (typeof body.cancel_at_period_end === "boolean")
          m.cancel_at_period_end = body.cancel_at_period_end;
      }
      return Response.json(m);
    };
    return { f, ms };
  }
  const kv = () => {
    const m = new Map<string, string>();
    return {
      get: async (k: string) => m.get(k) ?? null,
      put: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
    };
  };
  const accEnv = (DEVICES = kv()) =>
    env({
      WHOP_PAID_PLAN_IDS: "plan_monthly,plan_yearly",
      WHOP_OAUTH_CLIENT_ID: "app_test",
      SITE_ORIGIN: "https://getsavant.pro",
    }) as ReturnType<typeof env> & { DEVICES: ReturnType<typeof kv> };
  const alice = {
    ...member("trialing"),
    id: "mem_alice",
    user_id: "user_alice",
    variant_id: "plan_monthly",
    license_key: "KEY-ALICE-0001",
    billing_period_days: 30,
  };
  const as = (who: "alice" | "bob", path: string, body?: unknown) =>
    new Request(`https://lic.example${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer token-of-${who}-${who === "alice" ? "123456789" : "1234567890"}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("signs in with Whop, shows only the caller's plans, cancels and undoes, deactivates", async () => {
    const w = whopWithUsers([
      alice,
      { ...alice, id: "mem_bob", user_id: "user_bob", license_key: "KEY-BOB" },
    ]);
    const e = { ...accEnv(), DEVICES: kv() };
    const tok = await handle(
      post("/v1/auth/token", {
        code: "good",
        code_verifier: "v",
        redirect_uri: "https://getsavant.pro/account/",
      }),
      e,
      w.f,
    );
    expect(await tok.json()).toMatchObject({ ok: true, access_token: "token-of-alice-123456789" });
    expect(
      (await handle(post("/v1/auth/token", { code: "good", redirect_uri: "https://evil.example/" }), e, w.f))
        .status,
    ).toBe(400);
    const acct = (await (await handle(as("alice", "/v1/account"), e, w.f)).json()) as {
      plans: { id: string; plan: string; trial: boolean; license_key: string }[];
    };
    expect(acct.plans.map((p) => [p.id, p.plan, p.trial])).toEqual([["mem_alice", "Monthly", true]]);
    // bob can't touch alice's plan
    expect((await handle(as("bob", "/v1/account/cancel", { membership: "mem_alice" }), e, w.f)).status).toBe(
      404,
    );
    expect(
      (await handle(as("alice", "/v1/account/cancel", { membership: "mem_alice" }), e, w.f)).status,
    ).toBe(200);
    expect(w.ms[0]?.cancel_at_period_end).toBe(true);
    await handle(as("alice", "/v1/account/undo-cancel", { membership: "mem_alice" }), e, w.f);
    expect(w.ms[0]?.cancel_at_period_end).toBe(false);
    expect((await handle(new Request("https://lic.example/v1/account"), e, w.f)).status).toBe(401);
  });

  it("device sign-in: the app gets a code, the user approves on the site, the app picks up its key; moving needs a yes", async () => {
    const w = whopWithUsers([alice]);
    const e = { ...accEnv(), DEVICES: kv() };
    const start = async (machine: string, name: string) =>
      (await (await handle(post("/v1/device/start", { machine, name }), e, w.f)).json()) as {
        user_code: string;
        device_secret: string;
        verify_url: string;
      };
    const a = await start(M1, "Studio Mac");
    expect(a.verify_url).toBe(`https://getsavant.pro/activate/?code=${a.user_code}`);
    expect(
      await (await handle(post("/v1/device/poll", { device_secret: a.device_secret }), e, w.f)).json(),
    ).toMatchObject({
      status: "pending",
    });
    expect(
      await (await handle(as("alice", `/v1/device/info?code=${a.user_code}`), e, w.f)).json(),
    ).toMatchObject({
      device: "Studio Mac",
      plan: "Monthly",
      elsewhere: null,
    });
    expect((await handle(as("alice", "/v1/device/approve", { code: a.user_code }), e, w.f)).status).toBe(200);
    expect(
      await (await handle(post("/v1/device/poll", { device_secret: a.device_secret }), e, w.f)).json(),
    ).toMatchObject({
      status: "approved",
      key: "KEY-ALICE-0001",
    });
    // the key then activates through the normal path, on the bound machine only
    expect((await handle(post("/v1/activate", { key: "KEY-ALICE-0001", machine: M1 }), e, w.f)).status).toBe(
      200,
    );
    // a second computer must confirm the move; then the first one is refused at its next check
    const b = await start(M2, "Laptop");
    const refused = await handle(as("alice", "/v1/device/approve", { code: b.user_code }), e, w.f);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "bound_elsewhere", elsewhere: "Studio Mac" });
    expect(
      (await handle(as("alice", "/v1/device/approve", { code: b.user_code, move: true }), e, w.f)).status,
    ).toBe(200);
    expect((await handle(post("/v1/activate", { key: "KEY-ALICE-0001", machine: M1 }), e, w.f)).status).toBe(
      409,
    );
    // a user with only the free demo plan is told to start the trial
    const demo = whopWithUsers([{ ...alice, variant_id: "plan_free_demo" }]);
    const c = await start(M1, "x");
    const none = await handle(as("alice", "/v1/device/approve", { code: c.user_code }), e, demo.f);
    expect(none.status).toBe(402);
  });

  it("the app's side: start, approve in the browser, poll, activate (ADR-093)", async () => {
    const w = whopWithUsers([alice]);
    const e = { ...accEnv(), DEVICES: kv() };
    const home = mkdtempSync(join(tmpdir(), "savant-dev-"));
    const viaServer = (u: string, i?: RequestInit) => handle(new Request(u, i), e, w.f);
    const o = { server: "https://lic.example", fetcher: viaServer };
    const s = await startDeviceSignIn(home, o);
    if (!s.ok) throw new Error(s.message);
    expect(await pollDeviceSignIn(s.secret, o)).toEqual({ status: "pending" });
    expect((await handle(as("alice", "/v1/device/approve", { code: s.code }), e, w.f)).status).toBe(200);
    const p = await pollDeviceSignIn(s.secret, o);
    expect(p).toEqual({ status: "approved", key: "KEY-ALICE-0001" });
    const a = await activateKey(home, p.key as string, { ...o, pubkey: keys.publicKeyB64 });
    expect(a.ok).toBe(true);
    expect(readLicense(home, keys.publicKeyB64)).toMatchObject({ required: true, ok: true });
    expect(await pollDeviceSignIn(s.secret, o)).toEqual({ status: "expired" }); // used once
  });
});
