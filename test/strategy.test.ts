import { describe, expect, it } from "vitest";
import { contractViolations, DecisionContractSchema } from "../src/contracts/decision-contract.ts";
import { bounceParams, bounceSignal, inverseParams, inverseSignal } from "../src/strategy/BearAndBounce.ts";
import { baselineParams, baselineSignal, regimeProxyRiskOn } from "../src/strategy/CryptoBreakoutBaseline.ts";
import { atr, type Bar, ema, priorHigh } from "../src/strategy/indicators.ts";
import { kronosParams, kronosSignal } from "../src/strategy/KronosForecast.ts";
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

const DAY = 86_400_000;
/** n daily bars closing from `from` to `to` in a straight line, range 2 around each close. */
const line = (n: number, from: number, to: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = from + ((to - from) * i) / (n - 1);
    return { t: i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1 };
  });

describe("CRYPTO_OVERSOLD_BOUNCE_V1", () => {
  const p = bounceParams(doctrine);
  if (!p) throw new Error("bounce params missing");
  const bars = line(25, 130, 100); // a steady slide: RSI 0, far under the EMA20
  const base = {
    symbol: "ETH/USD",
    bars,
    ask: 102.02,
    now: 25 * DAY + 3_600_000, // every bar is complete
    contractId: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
    tick: 0.01,
    regimeScore: 30,
  };

  it("buys the reversal above yesterday's high with a stop under the swing low and an EMA target", () => {
    const { contract, reason } = bounceSignal({ ...base, bid: 102 }, p);
    expect(reason).toBe("oversold reversal");
    if (!contract) throw new Error("no contract");
    expect(DecisionContractSchema.parse(contract)).toBeTruthy();
    expect(contractViolations(contract)).toEqual([]);
    const stop = Number(contract.invalidation_criteria.stop_price);
    const target = Number(contract.entry_plan.targets[0]);
    expect(stop).toBeLessThan(99); // under the 5-day swing low (99)
    expect(102 - stop).toBeGreaterThanOrEqual(p.min_stop_atr * contract.atr - 0.01);
    expect(target - 102).toBeLessThanOrEqual(p.max_target_atr * contract.atr + 0.01);
    expect(target).toBeGreaterThan(102 + p.min_target_atr * contract.atr - 0.01);
  });

  it("waits for the reversal, skips capitulation and skips coins that are not oversold", () => {
    expect(bounceSignal({ ...base, bid: 100.5 }, p).reason).toMatch(/no reversal/);
    expect(bounceSignal({ ...base, bid: 102, regimeScore: 10 }, p).reason).toMatch(/capitulation/);
    const calm = { ...base, bars: line(25, 100, 100), bid: 101.5 };
    expect(bounceSignal(calm, p).reason).toMatch(/not oversold/);
  });

  it("ignores today's forming bar when judging yesterday", () => {
    const forming = [...bars, { t: 25 * DAY, o: 100, h: 140, l: 99, c: 101, v: 1 }];
    expect(bounceSignal({ ...base, bars: forming, bid: 102 }, p).contract).not.toBeNull();
  });
});

describe("EQUITY_INVERSE_BREAKOUT_V1", () => {
  const p = inverseParams(doctrine);
  if (!p) throw new Error("inverse params missing");
  const base = {
    symbol: "SH",
    bars: line(30, 36, 40), // inverse ETF trending up = index trending down
    ask: 41.62,
    now: 30 * DAY + 3_600_000,
    contractId: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
    tick: 0.01,
    gate: "equity posture REDUCE_ONLY",
  };

  it("buys the inverse breakout only while the regime is bearish", () => {
    const { contract } = inverseSignal({ ...base, bid: 41.6, bearish: true }, p);
    if (!contract) throw new Error("no contract");
    expect(DecisionContractSchema.parse(contract)).toBeTruthy();
    expect(contract.arena).toBe("EQUITIES");
    expect(Number(contract.invalidation_criteria.stop_price)).toBeLessThan(41.6);
    expect(inverseSignal({ ...base, bid: 41.6, bearish: false }, p).contract).toBeNull();
    expect(inverseSignal({ ...base, bid: 40.5, bearish: true }, p).reason).toMatch(/no breakout/);
  });
});

describe("CRYPTO_KRONOS_FORECAST_V1", () => {
  const p = kronosParams(doctrine);
  if (!p) throw new Error("kronos params missing");
  const now = 30 * DAY;
  const f = {
    symbol: "BTC/USD",
    last: 100,
    atr: 2,
    paths: 24,
    p_up: 0.7,
    p_win: 0.67,
    p_target_first: 0.2,
    p_stop_first: 0.08,
    exp_ret: 0.01,
    produced_at: now - 3_600_000,
    model: "NeoQuasar/Kronos-base",
  };
  const base = {
    symbol: "BTC/USD",
    bars: flatBars(30),
    bid: 100.1,
    ask: 100.12,
    now,
    contractId: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
    tick: 0.01,
    forecast: f,
    calibratedWin: 0.55,
    regimeScore: 40,
  };

  it("turns a fresh, favourable forecast into a RULE contract with the calibrated probability", () => {
    const { contract } = kronosSignal(base, p);
    if (!contract) throw new Error("no contract");
    expect(DecisionContractSchema.parse(contract)).toBeTruthy();
    expect(contractViolations(contract)).toEqual([]);
    expect(contract.win_prob_used).toBe(0.55); // never the raw model probability
    expect(Number(contract.invalidation_criteria.stop_price)).toBeCloseTo(100.1 - p.atr_stop_multiple * 2, 1);
    expect(contract.models_used[0]?.provider).toBe("kronos");
  });

  it("refuses stale, drifted, weak or stop-leaning forecasts", () => {
    expect(kronosSignal({ ...base, forecast: { ...f, produced_at: now - 6 * 3_600_000 } }, p).reason).toMatch(
      /stale/,
    );
    expect(kronosSignal({ ...base, bid: 102 }, p).reason).toMatch(/moved away/);
    expect(kronosSignal({ ...base, forecast: { ...f, p_win: 0.5 } }, p).reason).toMatch(/p_win/);
    expect(kronosSignal({ ...base, forecast: { ...f, p_stop_first: 0.4 } }, p).reason).toMatch(
      /stop more likely/,
    );
    expect(kronosSignal({ ...base, regimeScore: 10 }, p).reason).toMatch(/capitulation/);
  });
});
