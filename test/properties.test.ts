import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { doctrineViolations } from "../src/contracts/doctrine.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { Journal, verifyChain } from "../src/journal/Journal.ts";
import { evaluateBreaker } from "../src/risk/CircuitBreakerLadder.ts";
import { sizePosition } from "../src/risk/PositionSizer.ts";
import { constitution, doctrine } from "./helpers.ts";
import { memorySql } from "./sim/sqlite.ts";

/**
 * Property tests for the risk spine (audit W1-35; CLAUDE.md §9 promised them). Seeds are fixed so CI is
 * deterministic; each property runs 500 random cases.
 */
const RUNS = { numRuns: 500, seed: 54 };
const rung = doctrine.rungs.R1;

describe("risk spine properties", () => {
  it("P1: no sized order ever risks more than the rung's per-trade cap or breaks notional, cash and heat caps", () => {
    fc.assert(
      fc.property(
        fc.record({
          equity: fc.double({ min: 20, max: 500, noNaN: true }),
          entry: fc.double({ min: 0.01, max: 100_000, noNaN: true }),
          stopFrac: fc.double({ min: 0.005, max: 0.3, noNaN: true }),
          atrFrac: fc.double({ min: 0.001, max: 0.2, noNaN: true }),
          conviction: fc.integer({ min: 1, max: 10 }),
          pWin: fc.double({ min: 0, max: 1, noNaN: true }),
          lethality: fc.double({ min: 0, max: 1, noNaN: true }),
          cashFrac: fc.double({ min: 0, max: 1, noNaN: true }),
          heatFrac: fc.double({ min: 0, max: 0.12, noNaN: true }),
          minNotional: fc.constantFrom(1, 10),
        }),
        (x) => {
          const stop = x.entry * (1 - x.stopFrac);
          const r = sizePosition(
            {
              equityUsd: x.equity,
              rung,
              conviction: x.conviction,
              pWin: x.pWin,
              bearLethality: x.lethality,
              reputationWeight: 1.2,
              breakerMultiplier: 1,
              entry: x.entry,
              stop,
              atr: Math.min(x.atrFrac, x.stopFrac / doctrine.sizing.min_stop_atr_multiple) * x.entry,
              feeRt: 0.004,
              spreadFrac: 0.001,
              availableCashUsd: x.equity * x.cashFrac,
              heatRoomUsd: x.equity * x.heatFrac,
              minNotionalUsd: x.minNotional,
              minQty: 0,
              qtyIncrement: 1e-9,
            },
            doctrine,
          );
          if (!r.ok) return true;
          const eps = 1e-6;
          expect(r.riskUsd).toBeLessThanOrEqual(x.equity * rung.per_trade_risk + eps);
          expect(r.notionalUsd).toBeLessThanOrEqual(x.equity * rung.max_position_notional + eps);
          expect(r.notionalUsd).toBeLessThanOrEqual(x.equity * x.cashFrac + eps);
          expect(r.riskUsd).toBeLessThanOrEqual(x.equity * x.heatFrac + eps);
          return true;
        },
      ),
      RUNS,
    );
  });

  it("P2: loosening any rung limit above the constitution always fails the build gate", () => {
    const h = constitution.hard_limits;
    fc.assert(
      fc.property(
        fc.constantFrom("per_trade_risk", "max_position_notional", "total_heat"),
        fc.double({ min: 0.0001, max: 0.5, noNaN: true }),
        (field, extra) => {
          const d = structuredClone(doctrine);
          const cap =
            field === "per_trade_risk"
              ? h.max_per_trade_risk_pct
              : field === "max_position_notional"
                ? h.max_position_notional_pct
                : h.max_total_heat_pct;
          (d.rungs.R1 as Record<string, number>)[field] = cap + extra;
          return doctrineViolations(d, constitution).length > 0;
        },
      ),
      RUNS,
    );
  });

  it("P3: the breaker never gets more permissive as equity falls", () => {
    const order = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 1, max: 20_000 }), (a, b) => {
        const band = (eq: number) =>
          order[
            evaluateBreaker(
              {
                equityCents: eq,
                hwmCents: 20_000,
                dayStartEquityCents: 20_000,
                stopouts24h: 0,
                locked: false,
              },
              doctrine,
            ).band
          ];
        const [hi, lo] = a >= b ? [a, b] : [b, a];
        return band(lo) >= band(hi);
      }),
      RUNS,
    );
  });

  it("P4: any appended journal verifies, and changing any one payload breaks the chain", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 30 }), { minLength: 2, maxLength: 25 }),
        fc.nat(),
        (texts, pick) => {
          const sql = memorySql();
          for (const s of HOT_SCHEMA) sql.exec(s);
          const j = new Journal(sql);
          for (const [i, t] of texts.entries()) j.append("SYSTEM", "K", null, { t }, 1_000 + i);
          const rows = (
            sql.exec("SELECT row_json FROM d1_outbox WHERE tbl = 'journal' ORDER BY id") as {
              row_json: string;
            }[]
          ).map((r) => JSON.parse(r.row_json));
          if (!verifyChain(rows).ok) return false;
          const k = pick % rows.length;
          rows[k] = { ...rows[k], payload_json: `${rows[k].payload_json} ` };
          return !verifyChain(rows).ok;
        },
      ),
      { numRuns: 200, seed: 54 },
    );
  });
});

describe("journal re-anchor (audit W1-03)", () => {
  const fresh = () => {
    const sql = memorySql();
    for (const s of HOT_SCHEMA) sql.exec(s);
    return { sql, j: new Journal(sql) };
  };
  const sha = "a".repeat(64);

  it("adopts D1's head only when the hot head is empty and nothing is pending", async () => {
    const { j } = fresh();
    expect(await j.reanchor(async () => ({ seq: 500, sha }))).toBe("adopted");
    expect(j.head()).toEqual({ seq: 500, sha });
    expect(j.append("SYSTEM", "K", null, {}, 1).seq).toBe(501);
    expect(await j.reanchor(async () => ({ seq: 9, sha }))).toBe("kept");
  });

  it("keeps a fresh chain when D1 is empty, and never overrides pending rows", async () => {
    const a = fresh();
    expect(await a.j.reanchor(async () => null)).toBe("fresh");
    const b = fresh();
    b.j.append("SYSTEM", "K", null, {}, 1);
    b.sql.exec("DELETE FROM journal_head");
    expect(await b.j.reanchor(async () => ({ seq: 500, sha }))).toBe("kept");
  });
});

describe("constitution as properties (audit W3-33)", () => {
  it("P5: a KILLED account, a RED/ORANGE band, or a REDUCE_ONLY/PAUSED mode never gets an entry through", async () => {
    const { validateEntry } = await import("../src/risk/PreTradeValidator.ts");
    const { contract, account, input } = await import("./fixtures/validator.ts");
    fc.assert(
      fc.property(
        fc.record({
          killed: fc.boolean(),
          band: fc.constantFrom("GREEN", "YELLOW", "ORANGE", "RED"),
          mode: fc.constantFrom("NORMAL", "THRIFT", "REDUCE_ONLY", "PAUSED"),
          equity: fc.double({ min: 20, max: 500, noNaN: true }),
        }),
        (x) => {
          const blocked =
            x.killed ||
            x.band === "RED" ||
            x.band === "ORANGE" ||
            x.mode === "REDUCE_ONLY" ||
            x.mode === "PAUSED";
          const r = validateEntry(
            {
              ...input,
              contract,
              account: {
                ...account,
                killed: x.killed,
                band: x.band as "GREEN",
                breakerMultiplier: doctrine.breakers.multipliers[x.band as "GREEN"],
                mode: x.mode as "NORMAL",
                equityUsd: x.equity,
                availableCashUsd: x.equity,
              },
            },
            doctrine,
            constitution,
          );
          return !blocked || !r.ok;
        },
      ),
      RUNS,
    );
  });
});

describe("breaker hysteresis (audit W3-01)", () => {
  it("worse bands apply at once; recovery needs the margin for recovery_pulses evaluations in a row", async () => {
    const { withHysteresis, evaluateBreaker } = await import("../src/risk/CircuitBreakerLadder.ts");
    const at = (equityCents: number) =>
      evaluateBreaker(
        { equityCents, hwmCents: 10_000, dayStartEquityCents: equityCents, stopouts24h: 0, locked: false },
        doctrine,
      );
    expect(withHysteresis("GREEN", at(9_600), 0, doctrine).state.band).toBe("YELLOW"); // 4% → YELLOW at once
    let streak = 0;
    let band: "GREEN" | "YELLOW" | "ORANGE" | "RED" = "YELLOW";
    for (const eq of [9_710, 9_760, 9_760, 9_760]) {
      // 2.9% is under 3% but inside the 0.5% margin → no credit; 2.4% earns credit
      const h = withHysteresis(band, at(eq), streak, doctrine);
      band = h.state.band;
      streak = h.streak;
    }
    expect(band).toBe("GREEN"); // after 3 clear evaluations
    const flicker = withHysteresis("YELLOW", at(9_760), 1, doctrine);
    expect(flicker.state.band).toBe("YELLOW");
    expect(withHysteresis("YELLOW", at(9_710), 2, doctrine).streak).toBe(0); // inside the margin resets
  });
});

describe("applyMap (audit F-B1-09: the TS twin gets its own direct test)", () => {
  it("interpolates, clamps outside the fitted range and stays monotone", async () => {
    const { applyMap } = await import("../src/contracts/calibration.ts");
    const map = { n: 60, points: [[0.2, 0.25], [0.5, 0.45], [0.8, 0.6]] as [number, number][] };
    expect(applyMap(map, 0.1)).toBe(0.25);
    expect(applyMap(map, 0.9)).toBe(0.6);
    expect(applyMap(map, 0.5)).toBeCloseTo(0.45);
    expect(applyMap(map, 0.65)).toBeCloseTo(0.525);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.01) {
      const y = applyMap(map, x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});
