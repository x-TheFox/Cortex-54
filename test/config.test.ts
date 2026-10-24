import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConstitutionSchema } from "../src/contracts/constitution.ts";
import { type Doctrine, DoctrineSchema, doctrineViolations } from "../src/contracts/doctrine.ts";

const constitution = ConstitutionSchema.parse(JSON.parse(readFileSync("config/constitution.json", "utf8")));
const doctrine = DoctrineSchema.parse(parse(readFileSync("config/doctrine.yaml", "utf8")));
const clone = (): Doctrine => structuredClone(doctrine);

describe("config", () => {
  it("constitution has exactly the 8 untouchables U1..U8", () => {
    expect(constitution.untouchables.map((u) => u.id)).toEqual([
      "U1",
      "U2",
      "U3",
      "U4",
      "U5",
      "U6",
      "U7",
      "U8",
    ]);
  });

  it("shipped doctrine is within the constitution", () => {
    expect(doctrineViolations(doctrine, constitution)).toEqual([]);
  });

  it("rejects a rung looser than the constitution", () => {
    const d = clone();
    d.rungs.R1.per_trade_risk = constitution.hard_limits.max_per_trade_risk_pct + 0.01;
    expect(doctrineViolations(d, constitution)).toContain("R1.per_trade_risk > constitution");
  });

  it("rejects options strategies whose structure the constitution does not allow", () => {
    const d = clone();
    const s = d.strategies.find((x) => x.arena === "OPTIONS");
    if (!s?.params) throw new Error("no options strategy in doctrine");
    s.params.structure = "naked_put";
    expect(doctrineViolations(d, constitution).some((v) => v.includes("naked_put"))).toBe(true);
  });

  it("only lets the inverse strategy hold constitution-approved 1x inverse ETFs (ADR-040)", () => {
    const d = clone();
    const s = d.strategies.find((x) => x.params?.instrument === "inverse_etf_1x");
    if (!s) throw new Error("no inverse strategy in doctrine");
    s.universe = [...(s.universe ?? []), "SQQQ"];
    expect(doctrineViolations(d, constitution).some((v) => v.includes("SQQQ"))).toBe(true);
    expect(constitution.forbidden).toContain("leveraged_etf");
  });

  it("rejects a strategy whose params don't match its schema (a doctrine typo fails the build, not a pulse)", () => {
    const d = clone();
    const s = d.strategies.find((x) => x.id === "CRYPTO_BREAKOUT_BASELINE_V1");
    if (!s?.params) throw new Error("baseline missing");
    s.params.atr_stop_multple = s.params.atr_stop_multiple; // typo: the real key goes missing
    delete s.params.atr_stop_multiple;
    expect(doctrineViolations(d, constitution).some((v) => v.includes("atr_stop_multiple"))).toBe(true);
    const k = d.strategies.find((x) => x.id === "CRYPTO_KRONOS_FORECAST_V1");
    if (!k?.params) throw new Error("kronos missing");
    k.params.lookback_hours = 4 * 600; // 600 candles > the 512 context
    expect(doctrineViolations(d, constitution).some((v) => v.includes("context"))).toBe(true);
  });

  it("rejects LIVE autonomy above the unratified maximum", () => {
    const d = clone();
    const live = d.accounts.LIVE;
    if (!live) throw new Error("LIVE account missing from doctrine");
    live.autonomy_stop = 3;
    expect(doctrineViolations(d, constitution).some((v) => v.startsWith("LIVE autonomy_stop"))).toBe(true);
  });

  it("rejects options strategies on LIVE", () => {
    const d = clone();
    d.strategies.push({ id: "OPT_TEST_V1", arena: "OPTIONS", status: "SHADOW", accounts: ["LIVE"] });
    expect(doctrineViolations(d, constitution)).toContain(
      "strategy OPT_TEST_V1 trades OPTIONS on LIVE, which the constitution forbids",
    );
  });

  it("rejects neuron allocations above the free 10,000/day", () => {
    const d = clone();
    d.budgets.workers_ai_neurons_per_day.tier1 = 9_000;
    expect(doctrineViolations(d, constitution)).toContain("neuron allocations exceed total_free");
  });

  it("rejects unordered breaker bands", () => {
    const d = clone();
    d.breakers.orange_drawdown = 0.02;
    expect(doctrineViolations(d, constitution)).toContain("breakers must be ordered yellow < orange < red");
  });
});
