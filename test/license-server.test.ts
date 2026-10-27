import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateKey, checkLicense, publisherKeygen, readLicense, refreshLicense } from "../local/license.ts";
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
