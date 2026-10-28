import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, newConfig, saveConfig } from "../local/config.ts";
import { LocalSettings } from "../local/settings.ts";
import { DEFAULT_HUB_URL, hubFromEnv } from "../src/hub/client.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "savant-community-"));
const paper = (h: string) => {
  const c = newConfig("paper");
  saveConfig(
    { ...c, keys: { ...c.keys, ALPACA_PAPER_KEY_ID: "PKTEST", ALPACA_PAPER_SECRET: "test-secret" } },
    h,
  );
};

function make(h: string, hubStatus = 200) {
  const calls: string[] = [];
  const s = new LocalSettings({
    home: h,
    cfg: () => loadConfig(h) ?? newConfig("demo"),
    reload: () => undefined,
    pool: () => null,
    clef: () => ({ ok: false, level: "off", text: "off" }),
    fetcher: async (u) => {
      calls.push(String(u));
      return Response.json({}, { status: hubStatus });
    },
  });
  return { s, calls };
}

type HubView = {
  hub: { joined: boolean; agentId: string | null; name: string | null; publish: boolean; follow: string[] };
};

describe("community hub in the app (ADR-095)", () => {
  it("never publishes a demo robot's simulated trades", async () => {
    const h = tmp();
    saveConfig(newConfig("demo"), h);
    const r = await make(h).s.hub({ join: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/simulated/);
  });

  it("is off until the user joins; joining makes an identity and shares from then on", async () => {
    const h = tmp();
    paper(h);
    const { s } = make(h);
    expect(((await s.view()) as HubView).hub.joined).toBe(false);
    expect(hubFromEnv({ HUB_URL: DEFAULT_HUB_URL, ...loadConfig(h)?.keys })).toBeNull();

    const r = await s.hub({ join: true, name: "Night <Owl>" });
    expect(r.ok).toBe(true);
    const v = ((await s.view()) as HubView).hub;
    expect(v).toMatchObject({ joined: true, name: "Night Owl", publish: true });
    expect(v.agentId).toMatch(/^[0-9a-f]{16}$/);
    const cfg = hubFromEnv({ HUB_URL: DEFAULT_HUB_URL, ...loadConfig(h)?.keys });
    expect(cfg).toMatchObject({ url: DEFAULT_HUB_URL, publish: true, name: "Night Owl" });

    expect((await s.hub({ publish: false })).ok).toBe(true);
    expect(((await s.view()) as HubView).hub.publish).toBe(false);
  });

  it("follows real agents only, never itself, and unfollows", async () => {
    const h = tmp();
    paper(h);
    const { s, calls } = make(h);
    expect((await s.hub({ follow: "3f9a0c2b7d1e4a55" })).ok).toBe(false); // not joined yet
    await s.hub({ join: true });
    const self = ((await s.view()) as HubView).hub.agentId as string;
    expect((await s.hub({ follow: self })).ok).toBe(false);
    expect((await s.hub({ follow: "not-an-id" })).ok).toBe(false);
    expect((await s.hub({ follow: "3F9A0C2B7D1E4A55" })).ok).toBe(true);
    expect(calls.at(-1)).toBe(`${DEFAULT_HUB_URL}/v1/agents/3f9a0c2b7d1e4a55`);
    expect(((await s.view()) as HubView).hub.follow).toEqual(["3f9a0c2b7d1e4a55"]);
    expect((await s.hub({ unfollow: "3f9a0c2b7d1e4a55" })).ok).toBe(true);
    expect(((await s.view()) as HubView).hub.follow).toEqual([]);

    const missing = make(h, 404).s;
    expect((await missing.hub({ follow: "0000000000000000" })).message).toMatch(/No agent/);
  });

  it("leaving needs the word LEAVE and removes the identity", async () => {
    const h = tmp();
    paper(h);
    const { s } = make(h);
    await s.hub({ join: true });
    expect((await s.hub({ leave: "yes" })).ok).toBe(false);
    expect((await s.hub({ leave: "LEAVE" })).ok).toBe(true);
    expect(((await s.view()) as HubView).hub.joined).toBe(false);
    expect(loadConfig(h)?.keys.HUB_AGENT_KEY).toBeUndefined();
  });
});
