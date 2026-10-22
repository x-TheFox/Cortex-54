import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSymbol, clientOrderId, uuidv7 } from "../src/lib/ids.ts";
import { floorToIncrement, roundPrice } from "../src/lib/num.ts";
import { sha256Hex } from "../src/lib/sha256.ts";

describe("sha256 (sync)", () => {
  it("matches NIST vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches node:crypto on random inputs of many lengths", () => {
    for (let len = 0; len < 300; len += 7) {
      const s = Array.from({ length: len }, (_, i) => String.fromCharCode(32 + ((i * 31 + len) % 90))).join(
        "",
      );
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});

describe("ids", () => {
  it("uuidv7 is version 7, variant 10, and time-ordered", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it("client_order_id is deterministic per intent and short", () => {
    const id = clientOrderId("PAPER", "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f", "ENTRY", 1);
    expect(id).toBe("c54-P-7c8d9e0f-E-1");
    expect(clientOrderId("PAPER", "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f", "ENTRY", 1)).toBe(id);
    expect(id.length).toBeLessThanOrEqual(48);
    const roles = (["ENTRY", "STOP", "EXIT"] as const).map((r) =>
      clientOrderId("LIVE", "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f", r, 1),
    );
    expect(new Set(roles).size).toBe(3); // regression: ENTRY and EXIT once collided on "E"
  });

  it("canonicalizes Alpaca crypto position symbols", () => {
    expect(canonicalSymbol("BTCUSD", "crypto")).toBe("BTC/USD");
    expect(canonicalSymbol("ETH/USD", "crypto")).toBe("ETH/USD");
    expect(canonicalSymbol("AAPL", "us_equity")).toBe("AAPL");
  });
});

describe("num", () => {
  it("floors quantity to the increment, never up", () => {
    expect(floorToIncrement(0.123456789, 0.0001)).toBe("0.1234");
    expect(floorToIncrement(0.3, 0.1)).toBe("0.3"); // float noise must not drop a whole step
    expect(floorToIncrement(0.00009, 0.0001)).toBe("0");
    expect(floorToIncrement(12.9, 1)).toBe("12");
  });

  it("rounds prices conservatively", () => {
    expect(roundPrice(100.129, 0.01, "down")).toBe("100.12");
    expect(roundPrice(100.121, 0.01, "up")).toBe("100.13");
  });
});
