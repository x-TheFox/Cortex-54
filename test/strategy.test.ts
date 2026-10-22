import { describe, expect, it } from "vitest";
import { contractViolations, DecisionContractSchema } from "../src/contracts/decision-contract.ts";
import { baselineParams, baselineSignal, regimeProxyRiskOn } from "../src/strategy/CryptoBreakoutBaseline.ts";
import { atr, type Bar, ema, priorHigh } from "../src/strategy/indicators.ts";
import { doctrine } from "./helpers.ts";

const flatBars = (n: number, price = 100, range = 2): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    t: i * 86_400_000,
    o: price,
    h: price + range / 2,
    l: price - range / 2,
    c: price,
    v: 1,
  }));

describe("indicators", () => {
  it("ATR of constant-range bars equals the range", () => {
    expect(atr(flatBars(30), 14)).toBeCloseTo(2, 9);
    expect(atr(flatBars(10), 14)).toBeNull();
  });
  it("EMA of a constant series is the constant", () => {
    expect(ema(Array(30).fill(5), 20)).toBeCloseTo(5, 9);
  });
  it("prior high excludes the current bar", () => {
    const bars = flatBars(25);
    bars.push({ t: 0, o: 100, h: 150, l: 99, c: 140, v: 1 });
    expect(priorHigh(bars, 20)).toBe(101);
  });
});

describe("CRYPTO_BREAKOUT_BASELINE_V1", () => {
  const p = baselineParams(doctrine);
  if (!p) throw new Error("baseline params missing");

  it("emits a schema-valid RULE contract on a breakout", () => {
    const { contract, reason } = baselineSignal(
      {
        symbol: "SOL/USD",
        bars: flatBars(30),
        bid: 102,
        ask: 102.02,
        regimeRiskOn: true,
        now: 1_793_000_000_000,
        contractId: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
        tick: 0.001,
      },
      p,
    );
    expect(reason).toBe("breakout");
    expect(contract).not.toBeNull();
    if (!contract) return;
    expect(DecisionContractSchema.parse(contract)).toBeTruthy();
    expect(contractViolations(contract)).toEqual([]);
    expect(Number(contract.invalidation_criteria.stop_price)).toBeCloseTo(102 - 2 * 2, 2);
    expect(Number(contract.entry_plan.targets[0])).toBeCloseTo(102 + 3 * 2, 2);
  });

  it("stays flat without a breakout or when the regime proxy is risk-off", () => {
    const common = {
      symbol: "SOL/USD",
      bars: flatBars(30),
      ask: 100.1,
      now: 0,
      contractId: "x",
      tick: 0.001,
    };
    expect(baselineSignal({ ...common, bid: 100.5, regimeRiskOn: true }, p).contract).toBeNull();
    expect(baselineSignal({ ...common, bid: 105, regimeRiskOn: false }, p).contract).toBeNull();
  });

  it("regime proxy compares the last close with its EMA", () => {
    const up = flatBars(30).map((b, i) => ({ ...b, c: 100 + i }));
    expect(regimeProxyRiskOn(up, p)?.riskOn).toBe(true);
    const down = flatBars(30).map((b, i) => ({ ...b, c: 200 - i }));
    expect(regimeProxyRiskOn(down, p)?.riskOn).toBe(false);
  });
});
