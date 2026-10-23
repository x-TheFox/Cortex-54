import { describe, expect, it } from "vitest";
import { hudMessage } from "../src/cortex/Brain.ts";
import { parseChannels } from "../src/discord/notifier.ts";
import { verifyDiscordRequest } from "../src/discord/verify.ts";

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const hex = Buffer.from(raw).toString("hex");
  const sign = async (msg: string) =>
    Buffer.from(
      new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(msg)),
      ),
    ).toString("hex");
  return { hex, sign };
}

describe("Discord signature verification", () => {
  it("accepts a valid signature and rejects tampering, replays and garbage", async () => {
    const { hex, sign } = await keypair();
    const now = 1_793_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const body = '{"type":1}';
    const sig = await sign(ts + body);
    expect(await verifyDiscordRequest(hex, sig, ts, body, now)).toBe(true);
    expect(await verifyDiscordRequest(hex, sig, ts, '{"type":2}', now)).toBe(false);
    expect(await verifyDiscordRequest(hex, sig, ts, body, now + 10 * 60_000)).toBe(false); // stale timestamp
    expect(await verifyDiscordRequest(hex, null, ts, body, now)).toBe(false);
    expect(await verifyDiscordRequest(hex, "zz", ts, body, now)).toBe(false);
  });
});

describe("interaction parsing", () => {
  it("accepts only numeric channel ids", () => {
    expect(parseChannels('{"alarms":"123456789012345678","court":"abc"}')).toEqual({
      alarms: "123456789012345678",
    });
    expect(parseChannels("not json")).toEqual({});
  });

  it("HUD offers pause and a two-step flatten only for a configured PAPER account", () => {
    const base = {
      now: 0,
      lastPulseAt: null,
      equity: {},
      budget: { mode: "NORMAL" as const, worst: { resource: "x", fraction: 0 }, fractions: {} },
      journalHead: { seq: 1, sha: "0".repeat(64) },
      outboxPending: 0,
      regimes: [],
    };
    expect(hudMessage({ ...base, accounts: [] } as never).components).toEqual([]);
    const paper = {
      account: "PAPER",
      configured: true,
      mode: "NORMAL",
      modeReason: null,
      positions: [],
      openOrders: [],
      breaker: "GREEN",
      equityUsd: 54,
      brokerEquityUsd: 54,
      modeledCostUsd: 0,
      hwmUsd: 54,
      rung: "R1",
      autonomyStop: 2,
      locked: false,
      ordersToday: 0,
    };
    const ids = (m: ReturnType<typeof hudMessage>) =>
      (m.components ?? []).flatMap((r) => r.components.map((c) => c.custom_id));
    expect(ids(hudMessage({ ...base, accounts: [paper] } as never))).toEqual([
      "pause:PAPER",
      "flatten:PAPER",
    ]);
    expect(ids(hudMessage({ ...base, accounts: [{ ...paper, mode: "PAUSED" }] } as never))).toEqual([
      "resume:PAPER",
      "flatten:PAPER",
    ]);
  });

  it("HUD renders without configured accounts", () => {
    const msg = hudMessage({
      now: 0,
      lastPulseAt: null,
      equity: {},
      budget: { mode: "NORMAL", worst: { resource: "none", fraction: 0 }, fractions: {} },
      journalHead: { seq: 0, sha: "0".repeat(64) },
      outboxPending: 0,
      regimes: [],
      accounts: [],
    });
    expect(msg.content).toContain("pulse never");
  });
});
