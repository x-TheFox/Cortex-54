import type { Doctrine } from "../contracts/doctrine.ts";

export type RungName = "R1" | "R2" | "R3" | "R4" | "R5";
export type Rung = Doctrine["rungs"]["R1"];

const ORDER: RungName[] = ["R1", "R2", "R3", "R4", "R5"];

/** Rung for an equity level. Rungs only move up through graduation (RISK_DOCTRINE §7); this gives the cap. */
export function rungForEquity(equityUsd: number, d: Doctrine): RungName {
  for (const name of ORDER) {
    const r = d.rungs[name];
    if (r.equity_max === null || equityUsd < r.equity_max) return name;
  }
  return "R5";
}

/** The effective rung is the lower of the earned rung and what the equity supports. */
export function effectiveRung(earned: RungName, equityUsd: number, d: Doctrine): RungName {
  const byEquity = rungForEquity(equityUsd, d);
  return ORDER.indexOf(earned) <= ORDER.indexOf(byEquity) ? earned : byEquity;
}
