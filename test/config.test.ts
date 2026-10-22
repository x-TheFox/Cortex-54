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
