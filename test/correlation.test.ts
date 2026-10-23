import { describe, expect, it } from "vitest";
import { correlation, correlationVeto, MIN_OVERLAP } from "../src/risk/correlation.ts";
import type { Bar } from "../src/strategy/indicators.ts";

const DAY = 86_400_000;
const series = (moves: number[], start = 0): Bar[] => {
  let c = 100;
  return moves.map((m, i) => {
    c *= 1 + m;
    return { t: start + i * DAY, o: c, h: c, l: c, c, v: 1 };
  });
};
const wiggle = (n: number, seed: number) => Array.from({ length: n }, (_, i) => Math.sin(i * seed) * 0.02);

describe("correlation guard", () => {
  it("measures aligned daily returns", () => {
    const a = series(wiggle(40, 1.3));
    expect(correlation(a, series(wiggle(40, 1.3)), 0)).toBeCloseTo(1, 6);
    expect(correlation(a, series(wiggle(40, 1.3).map((x) => -x)), 0)).toBeCloseTo(-1, 3);
    expect(correlation(a, series(wiggle(MIN_OVERLAP - 5, 1.3)), 0)).toBeNull(); // too little overlap
  });
  it("vetoes only above the threshold and names the held symbol", () => {
    const cand = series(wiggle(40, 1.3));
    const held = { "ETH/USD": series(wiggle(40, 0.7)), "BTC/USD": series(wiggle(40, 1.3)) };
    expect(correlationVeto(cand, held, 0.7, 0)).toEqual({ symbol: "BTC/USD", corr: 1 });
    expect(correlationVeto(cand, { "ETH/USD": held["ETH/USD"] }, 0.7, 0)).toBeNull();
  });
});
