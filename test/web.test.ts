import { describe, expect, it } from "vitest";
import { CORTEX_COMMANDS as DISCORD_COMMANDS } from "../src/discord/commands.ts";
import { handleWeb, loginLink, type WebBrain, type WebEnv } from "../src/web/api.ts";
import { OPERATOR_COMMANDS, runCommand } from "../src/web/commands.ts";
import { cookieValue, SESSION_COOKIE, SESSION_TTL_MS, signToken, verifyToken } from "../src/web/session.ts";

const SECRET = "test-secret-0123456789";

describe("session tokens", () => {
  it("verify kind, expiry and signature", async () => {
    const now = 1_000_000;
    const t = await signToken(SECRET, { k: "login", exp: now + 1000, n: "abc" });
    expect((await verifyToken(SECRET, t, "login", now))?.n).toBe("abc");
    expect(await verifyToken(SECRET, t, "session", now)).toBeNull();
    expect(await verifyToken(SECRET, t, "login", now + 2000)).toBeNull();
    expect(await verifyToken("other-secret", t, "login", now)).toBeNull();
    const [body, sig] = t.split(".");
    expect(await verifyToken(SECRET, `${body}x.${sig}`, "login", now)).toBeNull();
    expect(await verifyToken(SECRET, null, "login", now)).toBeNull();
    expect(cookieValue("a=1; c54s=tok.en; b=2", SESSION_COOKIE)).toBe("tok.en");
  });
});

function fakeBrain() {
  const used = new Set<string>();
  const calls: string[] = [];
  const b: WebBrain = {
    status: async () => ({ ok: true }),
    feed: async () => [],
    memory: async () => ({ beliefs: [], reputation: {}, scars: [] }),
    equity: async () => ({}),
    forecast: async (sym) => ({ symbol: sym }),
    consumeOnce: async (id) => {
      if (used.has(id)) return false;
      used.add(id);
      return true;
    },
    isRevoked: async (id) => used.has(id),
    pause: (a, by) => {
      calls.push(`pause ${a} ${by}`);
      return "paused";
    },
    resume: () => "resumed",
    setDial: (a, s, _by, r) => `dial ${a} ${s} ${r}`,
    unlock: () => "unlocked",
    flatten: async () => "flattened",
    court: async (s) => `court ${s}`,
    why: (s) => `why ${s}`,
    roast: async (s, th) => `roast ${s} ${th}`,
    book: async () => "book",
    universe: () => "universe",
  };
  return { b, calls };
}

const env: WebEnv = { WEB_SESSION_SECRET: SECRET, OPERATOR_DISCORD_ID: "42" };
const req = (path: string, init: RequestInit = {}) => new Request(`https://cortex.test${path}`, init);

describe("web API", () => {
  it("login link → single-use session cookie → state and commands", async () => {
    const { b, calls } = fakeBrain();
    const link = (await loginLink(env, "https://cortex.test")) as string;
    const t = link.split("#login=")[1] as string;
    const login = () => handleWeb(req("/api/login", { method: "POST", body: JSON.stringify({ t }) }), env, b);
    const r1 = await login();
    expect(r1.status).toBe(200);
    const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(cookie.startsWith("c54s=")).toBe(true);
    expect((await login()).status).toBe(401); // single use

    expect((await handleWeb(req("/api/state"), env, b)).status).toBe(401);
    expect((await handleWeb(req("/api/state", { headers: { cookie } }), env, b)).status).toBe(200);

    const cmd = (body: unknown, headers: Record<string, string> = { cookie, "x-cortex-web": "1" }) =>
      handleWeb(req("/api/command", { method: "POST", headers, body: JSON.stringify(body) }), env, b);
    expect((await cmd({ name: "pause", account: "PAPER" }, { cookie })).status).toBe(400); // header required
    const ok = await cmd({ name: "pause", account: "PAPER" });
    expect(ok.status).toBe(200);
    expect(calls).toEqual(["pause PAPER web:42"]);
    // ADR-071: LIVE autonomy and unlocks work from the app, but only on a fresh sign-in (≤ 10 min)
    const live = await cmd({ name: "dial", account: "LIVE", stop: 3, confirm: "RATIFY" });
    expect(live.status).toBe(200);
    expect(((await live.json()) as { message: string }).message).toBe("dial LIVE 3 true");
    const old = await signToken(SECRET, {
      k: "session",
      exp: Date.now() + SESSION_TTL_MS - 11 * 60_000, // signed in 11 minutes ago
      n: "old-session",
    });
    const stale = { cookie: `c54s=${old}`, "x-cortex-web": "1" };
    expect((await cmd({ name: "dial", account: "LIVE", stop: 3, confirm: "RATIFY" }, stale)).status).toBe(
      403,
    );
    expect((await cmd({ name: "unlock", account: "LIVE", postmortem: "x".repeat(60) }, stale)).status).toBe(
      403,
    );
    expect((await cmd({ name: "pause", account: "PAPER" }, stale)).status).toBe(200); // everything else still works
    expect((await cmd({ name: "flatten", account: "PAPER" })).status).toBe(400);
    expect((await cmd({ name: "flatten", account: "PAPER", confirm: "FLATTEN" })).status).toBe(200);
    expect((await cmd({ name: "rm", account: "PAPER" })).status).toBe(400);
    // audit W1-26: logout revokes the session server-side; the same cookie can no longer command
    expect(
      (await handleWeb(req("/api/logout", { method: "POST", headers: { cookie } }), env, b)).status,
    ).toBe(200);
    expect((await cmd({ name: "pause", account: "PAPER" })).status).toBe(401);
  });

  it("refuses everything when no secret is configured", async () => {
    const { b } = fakeBrain();
    expect((await handleWeb(req("/api/state"), {}, b)).status).toBe(503);
  });
});

describe("Discord ↔ web parity (Phase 6 exit)", () => {
  it("every operator command exists on both front ends", async () => {
    const discord = DISCORD_COMMANDS.map((c) => c.name).filter((n) => n !== "terminal");
    expect(new Set(discord)).toEqual(new Set(OPERATOR_COMMANDS));
    const { b } = fakeBrain();
    for (const name of OPERATOR_COMMANDS.filter((n) => n !== "status")) {
      const r = await runCommand(
        b,
        name,
        { account: "PAPER", stop: 2, symbol: "BTC/USD", postmortem: "x" },
        "t",
      );
      expect(r.ok, name).toBe(true);
    }
  });
});
