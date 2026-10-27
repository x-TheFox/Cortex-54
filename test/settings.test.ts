import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, newConfig, saveConfig } from "../local/config.ts";
import { runtimeChecks } from "../local/health.ts";
import { LocalSettings, mergeEndpoints, plain } from "../local/settings.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { discordSetup } from "../src/discord/setup.ts";
import { InboxNotifier, readFeed } from "../src/notify/inbox.ts";
import { handleWeb, loginLink, type WebBrain } from "../src/web/api.ts";
import { memorySql } from "./sim/sqlite.ts";

const home = () => mkdtempSync(join(tmpdir(), "cortex-settings-"));

function settingsFor(h: string, fetcher?: (u: string, i?: RequestInit) => Promise<Response>) {
  let reloads = 0;
  const s = new LocalSettings({
    home: h,
    cfg: () => loadConfig(h) ?? newConfig(),
    reload: () => {
      reloads++;
    },
    pool: () => null,
    clef: () => ({ ok: false, level: "off", text: "off" }),
    ...(fetcher ? { fetcher } : {}),
  });
  return { s, reloads: () => reloads };
}

describe("local settings (ADR-071/072/073)", () => {
  it("saves keys and endpoints, never sends a key back, keeps a saved key when the page sends a blank one", async () => {
    const h = home();
    saveConfig(newConfig("demo"), h);
    const { s } = settingsFor(h);
    const r = await s.save({
      keys: { GROQ_API_KEY: "gsk_secret_value_1234" },
      llm: {
        endpoints: [
          {
            name: "My Claude",
            format: "anthropic",
            url: "https://api.anthropic.com/v1",
            key: "sk-ant-zzzz9876",
            models: ["claude-opus-5-5"],
            tier: "paid",
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
    const view = JSON.stringify(await s.view());
    expect(view).not.toContain("gsk_secret_value_1234");
    expect(view).not.toContain("sk-ant-zzzz9876");
    expect(view).toContain("…1234");
    expect(view).toContain("…9876");
    const cfg = loadConfig(h);
    expect(cfg?.llm.endpoints[0]).toMatchObject({
      id: "my-claude",
      url: "https://api.anthropic.com",
      key: "sk-ant-zzzz9876",
    });
    // the page re-sends the endpoint with a blank key (it never had it): the saved key stays
    await s.save({
      llm: {
        endpoints: [
          {
            id: "my-claude",
            name: "My Claude",
            format: "anthropic",
            url: "https://api.anthropic.com",
            key: "",
            models: ["claude-opus-5-5", "claude-sonnet-5-5"],
            tier: "paid",
          },
        ],
      },
    });
    expect(loadConfig(h)?.llm.endpoints[0]).toMatchObject({
      key: "sk-ant-zzzz9876",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    });
    // null removes a key; unknown names and paper-without-keys are refused in plain words
    await s.save({ keys: { GROQ_API_KEY: null } });
    expect(loadConfig(h)?.keys.GROQ_API_KEY).toBeUndefined();
    expect((await s.save({ keys: { WEB_SESSION_SECRET: "x" } })).ok).toBe(false);
    expect((await s.save({ mode: "paper" })).message).toMatch(/Alpaca paper key/);
    expect((await s.save({ onboarded: true })).ok).toBe(true);
    expect(loadConfig(h)?.onboarded).toBe(true);
  });

  it("the support file and health checks carry no secret", async () => {
    const h = home();
    const cfg = newConfig("demo");
    saveConfig(cfg, h);
    const { s } = settingsFor(h);
    await s.save({
      keys: {
        GROQ_API_KEY: "gsk_topsecret_9999",
        CLOUDFLARE_API_TOKEN: "cf-secret-token-7777",
        NTFY_TOPIC: "cortex-private-topic-1234",
      },
      llm: {
        endpoints: [
          {
            name: "Mine",
            format: "openai",
            url: "https://llm.example/v1",
            key: "sk-mine-secret-5555",
            models: ["m1"],
            tier: "paid",
          },
        ],
      },
    });
    const text = JSON.stringify(await s.support());
    for (const secret of [
      "gsk_topsecret_9999",
      "cf-secret-token-7777",
      "sk-mine-secret-5555",
      "cortex-private-topic-1234",
      cfg.secrets.web_session,
      cfg.secrets.ingest_hmac,
      cfg.secrets.pill_token,
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("GROQ_API_KEY"); // names only
    expect(text).toContain("llm.example");
    const checks = (await s.checks()) as { checks: { name: string }[] };
    expect(checks.checks.map((c) => c.name)).toContain("AI models (the court)");
  });

  it("runtime checks read the brain's real /health shape (violations are a map)", () => {
    const now = 10_000_000;
    const base = { now, last_pulse_at: now - 5_000, jobs: { running: [], recent: [] } };
    const inv = (pv: unknown) =>
      runtimeChecks({ ...base, policy_violations: pv as Record<string, unknown> }).find(
        (c) => c.name === "Safety invariants",
      );
    expect(inv({})?.ok).toBe(true);
    expect(inv({ naked_position: "BTC/USD" })?.ok).toBe(false);
    const jobs = runtimeChecks({
      ...base,
      jobs: {
        running: ["x"],
        recent: [
          { at: 1, key: "k", event: "exit 0" },
          { at: 2, key: "k", event: "exit 1" },
        ],
      },
    });
    expect(jobs.find((c) => c.name === "Research jobs")).toMatchObject({ ok: true, warn: true });
    expect(runtimeChecks({ ...base, last_pulse_at: null }).find((c) => c.name === "Heartbeat")?.ok).toBe(
      false,
    );
  });

  it("endpoint ids are unique and stable; bad input is rejected whole", () => {
    const a = mergeEndpoints(
      [],
      [
        { name: "Groq", url: "https://api.groq.com/openai/v1", models: ["m"] },
        { name: "Groq", url: "https://api.groq.com/openai/v1", models: ["n"] },
      ],
    );
    expect(a.map((e) => e.id)).toEqual(["groq", "groq-2"]);
    expect(() => mergeEndpoints([], [{ name: "x", url: "ftp://nope", models: ["m"] }])).toThrow();
    expect(plain(new Error("HTTP 401 Unauthorized"))).toMatch(/rejected/);
    expect(plain(new Error("fetch failed ECONNREFUSED"))).toMatch(/reach/);
  });

  it("Discord connect: invite link when the bot is in no server; channels created once, reused after", async () => {
    let guilds: { id: string; name: string }[] = [];
    const channels: { id: string; name: string; type: number }[] = [];
    const posted: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      const path = url.replace("https://discord.com/api/v10", "");
      if (path === "/users/@me") return Response.json({ id: "bot1" });
      if (path === "/oauth2/applications/@me") return Response.json({ id: "app1" });
      if (path === "/users/@me/guilds") return Response.json(guilds);
      if (path === "/guilds/g1") return Response.json({ id: "g1", name: "Home", owner_id: "u1" });
      if (path === "/guilds/g1/channels" && init?.method === "GET") return Response.json(channels);
      if (path === "/guilds/g1/channels") {
        const b = JSON.parse(String(init?.body)) as { name: string; type: number };
        const c = { id: `c${channels.length + 1}`, name: b.name, type: b.type };
        channels.push(c);
        posted.push(b.name);
        return Response.json(c);
      }
      return new Response("?", { status: 404 });
    };
    const first = await discordSetup({ token: "t", fetcher });
    expect(first).toMatchObject({
      ok: false,
      needsInvite: true,
      inviteUrl: expect.stringContaining("client_id=app1"),
    });
    guilds = [{ id: "g1", name: "Home" }];
    const second = await discordSetup({ token: "t", fetcher });
    expect(second.ok).toBe(true);
    expect(posted).toHaveLength(9); // category + 8 channels
    const third = await discordSetup({ token: "t", fetcher });
    expect(third.ok && third.created).toEqual([]);
    expect(posted).toHaveLength(9);
    // through the settings page: token saved with the channel map, never echoed
    const h = home();
    saveConfig(newConfig("demo"), h);
    const { s, reloads } = settingsFor(h, fetcher);
    const r = (await s.discord({ token: "bot-token-abcd", guildId: "" })) as { ok: boolean; message: string };
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain("bot-token");
    expect(loadConfig(h)?.keys.DISCORD_CHANNELS).toContain("court");
    await new Promise((res) => setTimeout(res, 300));
    expect(reloads()).toBeGreaterThan(0);
    expect(
      (await discordSetup({ token: "bad", fetcher: async () => new Response("", { status: 401 }) })).ok,
    ).toBe(false);
  });
});

describe("the app's feed (ADR-071)", () => {
  it("keeps every card except the live HUD, pages back, filters, and leaves the agent log out of ALL", async () => {
    const sql = memorySql();
    for (const q of HOT_SCHEMA) sql.exec(q);
    let t = 1_000;
    const inner = new NullNotifier();
    const n = new InboxNotifier(sql, inner, () => t++, 50);
    await n.post("command_center", { content: "hud" });
    await n.post("court", { embeds: [{ title: "Court NVDA" }], components: [{ type: 1, components: [] }] });
    await n.post("terminal", { content: "log" });
    for (let i = 0; i < 60; i++) await n.post("executions", { content: `fill ${i}` });
    expect(inner.sent).toHaveLength(63); // Discord (or whatever is inside) still gets everything
    const all = readFeed(sql, { exclude: ["terminal"], limit: 200 });
    expect(all.some((f) => f.channel === "command_center" || f.channel === "terminal")).toBe(false);
    expect(all.length).toBeLessThanOrEqual(100); // bounded: pruned to `keep` every 50 writes
    expect(all[0]?.msg.content).toBe("fill 59");
    const older = readFeed(sql, { before: all[9]?.id ?? 0, limit: 5 });
    expect(older[0]?.id).toBeLessThan(all[9]?.id ?? 0);
    expect(readFeed(sql, { channel: "terminal" })).toHaveLength(1);
    const court = readFeed(sql, { channel: "court" });
    expect(court.length === 0 || court[0]?.msg.components === undefined).toBe(true); // buttons don't work in the app
  });

  it("settings routes need a session and the CSRF header; a cloud brain says where its settings live", async () => {
    const env = { WEB_SESSION_SECRET: "s".repeat(40) };
    const calls: string[] = [];
    const b = {
      status: async () => ({}),
      feed: async () => [],
      settings: {
        view: async () => ({ managed: "local" }),
        models: async () => ({ ok: true }),
        save: async (p: Record<string, unknown>) => {
          calls.push(JSON.stringify(p));
          return { ok: true, message: "saved" };
        },
        discord: async () => ({ ok: true }),
        detect: async () => ({ found: [] }),
        test: async () => ({ ok: true, message: "ok" }),
      },
      consumeOnce: async () => true,
      isRevoked: async () => false,
    } as unknown as WebBrain;
    const t = ((await loginLink(env, "https://x.test")) as string).split("#login=")[1];
    const login = await handleWeb(
      new Request("https://x.test/api/login", { method: "POST", body: JSON.stringify({ t }) }),
      env,
      b,
    );
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const save = (h: Record<string, string>) =>
      handleWeb(
        new Request("https://x.test/api/settings/save", {
          method: "POST",
          headers: h,
          body: '{"mode":"demo"}',
        }),
        env,
        b,
      );
    expect((await save({})).status).toBe(401);
    expect((await save({ cookie })).status).toBe(400);
    expect((await save({ cookie, "x-cortex-web": "1" })).status).toBe(200);
    expect(calls).toEqual(['{"mode":"demo"}']);
    const cloud = { ...b, settings: undefined } as WebBrain;
    const view = (await (
      await handleWeb(new Request("https://x.test/api/settings", { headers: { cookie } }), env, cloud)
    ).json()) as { managed: string };
    expect(view.managed).toBe("cloud");
    expect(
      (
        await handleWeb(
          new Request("https://x.test/api/settings/save", {
            method: "POST",
            headers: { cookie, "x-cortex-web": "1" },
            body: "{}",
          }),
          env,
          cloud,
        )
      ).status,
    ).toBe(404);
  });
});
