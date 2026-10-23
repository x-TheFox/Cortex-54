import { describe, expect, it } from "vitest";
import type { AccountView, StatusView } from "../web/src/api.ts";
import { drawdown, ecam } from "../web/src/ecam.ts";

const NOW = 1_800_000_000_000;
const acct = (over: Partial<AccountView> = {}): AccountView => ({
  account: "PAPER",
  configured: true,
  equityUsd: 54,
  brokerEquityUsd: 54,
  modeledCostUsd: 0,
  hwmUsd: 54,
  rung: "R1",
  autonomyStop: 2,
  breaker: "GREEN",
  locked: false,
  mode: "NORMAL",
  modeReason: null,
  reconciledAt: NOW,
  lastError: null,
  ordersToday: 0,
  positions: [],
  ...over,
});
const status = (over: Partial<StatusView> = {}): StatusView => ({
  now: NOW,
  lastPulseAt: NOW - 30_000,
  budget: { mode: "NORMAL", worst: { resource: "x", fraction: 0.2 }, fractions: {} },
  journalHead: { seq: 10, sha: "0".repeat(64) },
  outboxPending: 0,
  equity: {},
  regimes: [
    {
      arena: "CRYPTO",
      posture: "NEW_ENTRY_ALLOWED",
      score: 60,
      ceiling: null,
      ageMinutes: 30,
      fresh: true,
      source: "batch",
    },
  ],
  accounts: [
    acct(),
    acct({ account: "LIVE", configured: false, autonomyStop: 0, equityUsd: null, hwmUsd: null }),
  ],
  ...over,
});

describe("ECAM (dark cockpit)", () => {
  it("stays dark when everything is normal: memos only", () => {
    const e = ecam(status(), NOW);
    expect(e.warnings).toEqual([]);
    expect(e.cautions).toEqual([]);
    expect(e.memos).toContain("LIVE DORMANT");
    expect(e.memos).toContain("PAPER AUTO · STOP 2 · R1");
  });
  it("lights a warning for RED and a lost pulse, cautions for stale regime and pauses", () => {
    const e = ecam(
      status({
        lastPulseAt: NOW - 20 * 60_000,
        accounts: [acct({ breaker: "RED", locked: true }), acct({ account: "LIVE", mode: "PAUSED" })],
        regimes: [
          {
            arena: "EQUITIES",
            posture: "NEW_ENTRY_ALLOWED",
            score: 1,
            ceiling: null,
            ageMinutes: 2000,
            fresh: false,
            source: "b",
          },
        ],
      }),
      NOW,
    );
    expect(e.warnings.map((w) => w.id)).toEqual(["pulse-lost", "PAPER-red"]);
    expect(e.cautions.map((c) => c.id)).toEqual(["LIVE-paused", "stale-EQUITIES"]);
  });
  it("drawdown is measured from the high-water mark", () => {
    expect(drawdown(acct({ equityUsd: 50, hwmUsd: 55 }))).toBeCloseTo(5 / 55, 9);
    expect(drawdown(acct({ equityUsd: null }))).toBe(0);
  });
});
