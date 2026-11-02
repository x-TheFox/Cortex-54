import { describe, expect, it } from "vitest";
import { type ReadinessInput, readiness } from "../src/cortex/readiness.ts";

const base: ReadinessInput = {
  killed: false,
  license: { required: true, ok: true },
  realAccount: true,
  termsAccepted: true,
  modelsOk: true,
  account: { mode: "NORMAL", modeReason: null, locked: false, reconciledAt: 1 },
  warmingUp: false,
};

describe("ready to trade (audit UX-03/05/10)", () => {
  it("ready only when every gate passes", () => {
    expect(readiness(base)).toMatchObject({ ready: true, level: "ok" });
  });
  it("names the first blocker, in the order a user fixes them", () => {
    const all: ReadinessInput = {
      ...base,
      license: { required: true, ok: false, reason: "No licence installed." },
      termsAccepted: false,
      modelsOk: false,
      account: {
        mode: "REDUCE_ONLY",
        modeReason: "the broker account allows margin",
        locked: false,
        reconciledAt: 1,
      },
    };
    expect(readiness({ ...all, killed: true }).fix).toBe("controls");
    expect(readiness(all)).toMatchObject({ fix: "license", headline: expect.stringMatching(/licence/i) });
    expect(readiness({ ...all, license: base.license }).fix).toBe("terms");
    expect(readiness({ ...all, license: base.license, termsAccepted: true }).fix).toBe("models");
    expect(readiness({ ...all, license: base.license, termsAccepted: true, modelsOk: true }).fix).toBe(
      "account",
    );
  });
  it("the demo needs no licence or terms; a first scan is a self-clearing hold", () => {
    expect(
      readiness({ ...base, realAccount: false, termsAccepted: false, license: { required: true, ok: false } })
        .ready,
    ).toBe(true);
    expect(readiness({ ...base, warmingUp: true })).toMatchObject({ ready: false, level: "info" });
    expect(
      readiness({
        ...base,
        account: { mode: "REDUCE_ONLY", modeReason: "stale data", locked: false, reconciledAt: 1 },
      }),
    ).toMatchObject({ ready: false, level: "info", fix: null });
  });
});
