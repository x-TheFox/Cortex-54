import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeBackup, openBackup, restoreInto } from "../local/backup.ts";
import { loadConfig, newConfig, saveConfig } from "../local/config.ts";
import { memoryBackend, setSecretBackend } from "../local/keychain.ts";
import {
  checkLicense,
  entriesBlocked,
  issueLicense,
  publisherKeygen,
  readLicense,
} from "../local/license.ts";
import { isLoopback, LocalCortex } from "../local/runtime.ts";
import { LocalSettings } from "../local/settings.ts";
import { group, nextVersion } from "../scripts/changelog.ts";
import { LlmRouter } from "../src/court/llm.ts";
import { buildPool, costUsd, poolRouter } from "../src/court/pool.ts";
import { sessionCookie } from "../src/web/session.ts";
import { doctrine } from "./helpers.ts";
import { FakeMarketData, Market } from "./sim/FakeBroker.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "cortex-product-"));
const prefs = {
  prefer: "free_first" as const,
  round_robin: true,
  allow_same_model: false,
  demoted: [] as string[],
};
const ep = (id: string, models: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  format: "openai" as const,
  url: `https://${id}.example/v1`,
  key: "k",
  models,
  tier: "paid" as const,
  enabled: true,
  ...extra,
});

afterEach(() => setSecretBackend(null));

describe("cost meter, spend cap and demote (ADR-075)", () => {
  it("demoted models leave the rotation and the pool says so", () => {
    const built = buildPool(
      doctrine,
      {},
      {
        endpoints: [ep("a", ["gpt-x", "claude-y"])],
        prefs: { ...prefs, demoted: ["ep:a/claude-y"] },
      },
    );
    expect(built.report.entries.map((e) => e.model)).toEqual(["gpt-x"]);
    expect(built.report.notes.some((n) => /demoted/.test(n.text))).toBe(true);
  });

  it("prices become the router's pricing, and a provider stops for the day at its spend cap", async () => {
    const built = buildPool(
      doctrine,
      {},
      {
        endpoints: [
          ep("pricey", ["claude-y"], { price_in: 10, price_out: 50, daily_spend_cap: 0.01 }),
          ep("cheap", ["gpt-x"], { tier: "free" }),
        ],
        prefs: { ...prefs, prefer: "paid_first" as const, round_robin: false },
      },
    );
    expect(built.pricing["ep:pricey"]).toEqual({ in: 10, out: 50, cap: 0.01 });
    const calls: string[] = [];
    for (const name of ["pricey", "cheap"])
      built.providers[`ep:${name}`] = {
        async complete(model: string) {
          calls.push(`${name}/${model}`);
          return { text: '{"ok":1}', inputTokens: 600, outputTokens: 100 };
        },
      };
    const router = poolRouter(built, { ...prefs, prefer: "paid_first", round_robin: false });
    const tokens = new Map<string, { input: number; output: number }>();
    router.gate = {
      allow: () => true,
      used: () => undefined,
      tokens: (p, i, o) => {
        const t = tokens.get(p) ?? { input: 0, output: 0 };
        tokens.set(p, { input: t.input + i, output: t.output + o });
      },
      tokensToday: (p) => tokens.get(p) ?? { input: 0, output: 0 },
    };
    const req = { system: "s", user: "u", maxOutputTokens: 10, schema: {} };
    const chain = built.d.llm_routing.bull_chain;
    await router.run(
      chain,
      req,
      (j) => j,
      [],
      () => undefined,
    );
    // 600 in × $10/M + 100 out × $50/M = $0.011 ≥ $0.01 cap → the next call skips it
    expect(router.spentToday("ep:pricey")).toBeCloseTo(0.011, 6);
    await router.run(
      chain,
      req,
      (j) => j,
      [],
      () => undefined,
    );
    expect(calls).toEqual(["pricey/claude-y", "cheap/gpt-x"]);
    expect(costUsd({ in: 3, out: 15 }, 1_000_000, 100_000)).toBeCloseTo(4.5, 6);
  });

  it("a provider without a price is never capped", () => {
    const r = new LlmRouter({}, doctrine);
    expect(r.spentToday("groq")).toBe(0);
  });
});

describe("OS keychain (ADR-076)", () => {
  it("keychain mode keeps every key out of config.json and reads them back", () => {
    const b = memoryBackend();
    setSecretBackend(b);
    const h = tmp();
    const cfg = {
      ...newConfig("demo"),
      secret_store: "keychain" as const,
      keys: { GROQ_API_KEY: "gsk_topsecret_1111" },
      llm: { endpoints: [ep("mine", ["m1"], { key: "sk-endpoint-2222" })], prefs },
    };
    saveConfig(cfg, h);
    const file = readFileSync(join(h, "config.json"), "utf8");
    expect(file).not.toContain("gsk_topsecret_1111");
    expect(file).not.toContain("sk-endpoint-2222");
    expect(file).toContain("web_session"); // generated local secrets stay (the tray reads its pill token there)
    const back = loadConfig(h);
    expect(back?.keys.GROQ_API_KEY).toBe("gsk_topsecret_1111");
    expect(back?.llm.endpoints[0]?.key).toBe("sk-endpoint-2222");
    // and back to the file: the keychain item is removed
    saveConfig({ ...(back as NonNullable<typeof back>), secret_store: "file" }, h);
    expect(readFileSync(join(h, "config.json"), "utf8")).toContain("gsk_topsecret_1111");
    expect(b.store.size).toBe(0);
  });
});

describe("encrypted backups (ADR-076)", () => {
  const cfg = () => ({
    ...newConfig("paper"),
    keys: { ALPACA_PAPER_KEY_ID: "PKTEST", ALPACA_PAPER_SECRET: "s3cret-value", GROQ_API_KEY: "gsk_x" },
  });

  it("round-trips with the passphrase and refuses a wrong one", () => {
    const text = makeBackup({
      cfg: cfg(),
      includeKeys: true,
      passphrase: "correct horse",
      files: { "journal.sqlite": Buffer.from("journal-bytes") },
    });
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toContain("journal-bytes");
    const b = openBackup(text, "correct horse");
    expect(b.config.keys.ALPACA_PAPER_SECRET).toBe("s3cret-value");
    expect(b.files["journal.sqlite"]?.toString()).toBe("journal-bytes");
    expect(() => openBackup(text, "wrong horse!")).toThrow(/passphrase/i);
    expect(() => makeBackup({ cfg: cfg(), includeKeys: false, passphrase: "short", files: {} })).toThrow();
  });

  it("restoring keeps this computer's own secrets; a paper backup without keys starts in demo", () => {
    const text = makeBackup({ cfg: cfg(), includeKeys: false, passphrase: "passphrase-1", files: {} });
    const b = openBackup(text, "passphrase-1");
    expect(b.config.keys).toEqual({});
    const here = newConfig("demo");
    const h = tmp();
    const next = restoreInto(h, b, here);
    expect(next.secrets).toEqual(here.secrets);
    expect(next.mode).toBe("demo");
    expect(next.onboarded).toBe(true);
  });
});

describe("licences (ADR-077)", () => {
  const k = publisherKeygen();
  it("a build without a publisher key never checks", () => {
    expect(checkLicense(null, "")).toEqual({ required: false });
  });
  it("accepts a signed licence; refuses a tampered, foreign or expired one; paper without one holds entries", () => {
    const lic = issueLicense(k.privateKeyPem, { id: "lic-000001", licensee: "Ada", plan: "pro", days: 30 });
    const ok = checkLicense(lic, k.publicKeyB64);
    expect(ok).toMatchObject({ required: true, ok: true });
    expect(checkLicense({ ...lic, licensee: "Mallory" }, k.publicKeyB64)).toMatchObject({ ok: false });
    expect(checkLicense(lic, publisherKeygen().publicKeyB64)).toMatchObject({ ok: false });
    expect(checkLicense(lic, k.publicKeyB64, Date.now() + 31 * 86_400_000)).toMatchObject({ ok: false });
    const perpetual = issueLicense(k.privateKeyPem, {
      id: "lic-000002",
      licensee: "Ada",
      plan: "pro",
      days: null,
    });
    expect(checkLicense(perpetual, k.publicKeyB64)).toMatchObject({ ok: true, daysLeft: null });
    const h = tmp();
    expect(entriesBlocked(readLicense(h, k.publicKeyB64))).toBe(true);
    writeFileSync(join(h, "license.json"), JSON.stringify(lic));
    expect(entriesBlocked(readLicense(h, k.publicKeyB64))).toBe(false);
  });
});

describe("settings: court capacity, phone access, keys, reset (ADR-075/076)", () => {
  const make = (h: string, extra: Partial<ConstructorParameters<typeof LocalSettings>[0]> = {}) =>
    new LocalSettings({
      home: h,
      cfg: () => loadConfig(h) ?? newConfig(),
      reload: () => undefined,
      pool: () => null,
      clef: () => ({ ok: false, level: "off", text: "off" }),
      ...extra,
    });

  it("saves the court capacity (1–60, null = default) and phone access", async () => {
    const h = tmp();
    saveConfig(newConfig("demo"), h);
    const s = make(h);
    expect((await s.save({ court: { max_per_day: 24 }, lan: { enabled: true } })).ok).toBe(true);
    expect(loadConfig(h)).toMatchObject({ court: { max_per_day: 24 }, lan: { enabled: true } });
    await s.save({ court: { max_per_day: 999 } });
    expect(loadConfig(h)?.court.max_per_day).toBe(24); // out of range: unchanged
    await s.save({ court: { max_per_day: null } });
    expect(loadConfig(h)?.court.max_per_day).toBeUndefined();
  });

  it("pairing needs phone access on; reset needs the typed word", async () => {
    const h = tmp();
    saveConfig(newConfig("demo"), h);
    let wiped = false;
    const s = make(h, {
      pairLink: async () => "http://192.168.1.20:8754/#login=x",
      wipe: async () => {
        wiped = true;
      },
    });
    expect((await s.pair()).ok).toBe(false);
    await s.save({ lan: { enabled: true } });
    expect(await s.pair()).toMatchObject({ ok: true, url: "http://192.168.1.20:8754/#login=x" });
    expect((await s.reset({ confirm: "reset" })).ok).toBe(false);
    expect((await s.reset({ confirm: "RESET" })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(wiped).toBe(true);
  });
});

describe("local runtime: court capacity, phone access, tray health (ADR-075/076)", () => {
  const make = (over: Record<string, unknown> = {}) => {
    const home = tmp();
    const m = new Market(() => Date.now());
    m.set("BTC/USD", 100, 100.05);
    const cfg = {
      ...newConfig("demo"),
      research: { enabled: false, max_parallel: 1 },
      ...over,
    } as ReturnType<typeof newConfig>;
    return new LocalCortex({
      home,
      root: process.cwd(),
      cfg,
      overrides: { market: new FakeMarketData(m), clef: null, quiet: true },
    });
  };

  it("on the Wi-Fi a phone can't change settings; the computer itself can", async () => {
    const c = make({ lan: { enabled: true } });
    const req = () =>
      new Request("http://192.168.1.5:8754/api/settings/save", {
        method: "POST",
        headers: { "x-cortex-web": "1" },
        body: "{}",
      });
    const fromPhone = await c.route(req(), new URL(req().url), "192.168.1.77");
    expect(fromPhone.status).toBe(403);
    const fromHere = await c.route(req(), new URL(req().url), "127.0.0.1");
    expect(fromHere.status).not.toBe(403); // (401 here: no session cookie)
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("")).toBe(false);
    expect(sessionCookie("t", 60, false)).not.toContain("Secure");
    expect(sessionCookie("t", 60)).toContain("Secure");
    await c.stop();
  });

  it("the tray pill carries the one-line problem, and a backup snapshot reads the live databases", async () => {
    const c = make();
    expect(c.problem()).toMatch(/court needs AI models|Heartbeat/);
    const snap = c.snapshot();
    expect(snap["hot.sqlite"]?.subarray(0, 15).toString()).toBe("SQLite format 3");
    expect(snap["journal.sqlite"]?.length).toBeGreaterThan(0);
    await c.stop();
    expect(existsSync(join(tmpdir()))).toBe(true);
  });
});

describe("release changelog (ADR-077)", () => {
  it("bumps from the latest tag, starts at the app version", () => {
    expect(nextVersion(null, "0.1.0", "patch")).toBe("0.1.0");
    expect(nextVersion("v0.1.9", "0.1.0", "patch")).toBe("0.1.10");
    expect(nextVersion("v0.1.9", "0.1.0", "minor")).toBe("0.2.0");
    expect(nextVersion("v1.4.2", "0.1.0", "major")).toBe("2.0.0");
  });
  it("groups commit subjects", () => {
    const g = group([
      "Add phone pairing",
      "Fix the sandbox selling what it doesn't hold",
      "Kill switch: hold entries without a licence",
      "Docs: ADR-078",
      "Release v0.1.1",
      "Tidy imports",
    ]);
    expect(g.New).toEqual(["Add phone pairing"]);
    expect(g.Fixes).toHaveLength(1);
    expect(g.Safety).toHaveLength(1);
    expect(g.Docs).toHaveLength(1);
    expect(g.Changes).toEqual(["Tidy imports"]);
  });
});

describe("spend cap with one model on both sides (ADR-075)", () => {
  it("the bear alias spends from the same daily cap as its endpoint", async () => {
    const built = buildPool(
      doctrine,
      {},
      {
        endpoints: [ep("solo", ["claude-y"], { price_in: 10, price_out: 50, daily_spend_cap: 0.01 })],
        prefs: { ...prefs, allow_same_model: true },
      },
    );
    built.providers["ep:solo"] = {
      async complete() {
        return { text: '{"ok":1}', inputTokens: 600, outputTokens: 100 };
      },
    };
    const router = poolRouter(built, { ...prefs, allow_same_model: true });
    const tokens = new Map<string, { input: number; output: number }>();
    router.gate = {
      allow: () => true,
      used: () => undefined,
      tokens: (p, i, o) => {
        const t = tokens.get(p) ?? { input: 0, output: 0 };
        tokens.set(p, { input: t.input + i, output: t.output + o });
      },
      tokensToday: (p) => tokens.get(p) ?? { input: 0, output: 0 },
    };
    const req = { system: "s", user: "u", maxOutputTokens: 10, schema: {} };
    expect(
      await router.run(
        built.d.llm_routing.bull_chain,
        req,
        (j) => j,
        [],
        () => undefined,
      ),
    ).not.toBeNull();
    // the bull spent the cap: the bear alias of the same endpoint is out too
    expect(
      await router.run(
        built.d.llm_routing.bear_chain,
        req,
        (j) => j,
        [],
        () => undefined,
      ),
    ).toBeNull();
    expect([...tokens.keys()]).toEqual(["ep:solo"]);
  });
});

describe("MSIX package (ADR-079)", async () => {
  const { manifest, msixVersion } = await import("../scripts/msix.ts");
  it("uses a four-part version and Microsoft's unsigned-publisher OID unless a Store identity is given", () => {
    expect(msixVersion("0.1.12")).toBe("0.1.12.0");
    expect(() => msixVersion("x")).toThrow();
    const m = manifest({ version: "1.2.3", exe: "Savant.exe" });
    expect(m).toContain('Version="1.2.3.0"');
    expect(m).toContain("OID.2.25.311729368913984317654407730594956997722=1");
    expect(m).toContain('Executable="Savant.exe"');
    expect(m).toContain('rescap:Capability Name="runFullTrust"');
    const store = manifest({ version: "1.2.3", exe: "a&b.exe", publisher: "CN=ABC-123", name: "Pub.App" });
    expect(store).toContain('Publisher="CN=ABC-123"');
    expect(store).toContain('Executable="a&amp;b.exe"');
  });
});

describe("live account in local mode (ADR-083)", () => {
  it("connects dormant: no live order before RATIFY, and RATIFY takes two confirmations", async () => {
    const home = tmp();
    let now = Date.parse("2026-10-27T12:00:00Z");
    const m = new Market(() => now);
    m.set("BTC/USD", 100, 100.05);
    const { FakeBroker } = await import("./sim/FakeBroker.ts");
    const live = new FakeBroker(m, 54, () => now);
    const c = new LocalCortex({
      home,
      root: process.cwd(),
      cfg: { ...newConfig("demo"), research: { enabled: false, max_parallel: 1 } },
      now: () => now,
      overrides: { market: new FakeMarketData(m), clef: null, quiet: true, liveBroker: live },
    });
    await c.pulse();
    const st = c.brain.status().accounts.find((a) => a.account === "LIVE");
    expect(st?.configured).toBe(true);
    expect(st?.autonomyStop).toBe(0);
    expect(live.calls.some((x) => x.startsWith("submit"))).toBe(false);
    expect(c.brain.setDial("LIVE", 3, "web:local", false)).toMatch(/RATIFY/);
    expect(c.brain.setDial("LIVE", 3, "web:local", true)).toMatch(/Confirm again/);
    expect(c.brain.status().accounts.find((a) => a.account === "LIVE")?.autonomyStop).toBe(0);
    now += 11 * 60_000;
    expect(c.brain.setDial("LIVE", 3, "web:local", true)).toMatch(/Stop 3/);
    await c.stop();
  });

  it("refuses half a live key pair", async () => {
    const h = tmp();
    saveConfig(newConfig("demo"), h);
    const s = new LocalSettings({
      home: h,
      cfg: () => loadConfig(h) ?? newConfig(),
      reload: () => undefined,
      pool: () => null,
      clef: () => ({ ok: false, level: "off", text: "off" }),
    });
    expect((await s.save({ keys: { ALPACA_LIVE_KEY_ID: "AKxxxx" } })).ok).toBe(false);
  });
});
