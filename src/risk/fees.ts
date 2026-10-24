import type { Doctrine } from "../contracts/doctrine.ts";

export type Arena = "CRYPTO" | "EQUITIES" | "OPTIONS";
export type Liquidity = "maker" | "taker";

/**
 * Fee rate for one leg, as a fraction of notional. Equity regulatory fees on sells round up to at least
 * $0.01, which is material on tiny notionals ($0.01 on $18 ≈ 5.6 bps), so notional is required.
 */
export function legFeeRate(
  arena: Arena,
  side: "buy" | "sell",
  liquidity: Liquidity,
  notionalUsd: number,
  d: Doctrine,
): number {
  if (arena === "CRYPTO") return liquidity === "maker" ? d.fees.crypto_maker : d.fees.crypto_taker;
  if (arena === "EQUITIES") {
    const reg = side === "sell" && notionalUsd > 0 ? d.fees.equity_sell_regulatory_min_usd / notionalUsd : 0;
    return d.fees.equity_commission + reg;
  }
  return 0.0065 / Math.max(notionalUsd, 1); // options: placeholder (paper only, Phase 5)
}

/** Round trip assumed by the risk engine: passive (maker) entry, taker exit (stops are takers). */
export function roundTripFeeRate(arena: Arena, notionalUsd: number, d: Doctrine): number {
  return (
    legFeeRate(arena, "buy", "maker", notionalUsd, d) + legFeeRate(arena, "sell", "taker", notionalUsd, d)
  );
}

/** Fee hurdle (Tier 0): expected move must clear hurdle_multiple × (round-trip fees + half spread). */
export function clearsFeeHurdle(
  expectedMoveFrac: number,
  feeRt: number,
  spreadFrac: number,
  d: Doctrine,
): { ok: boolean; required: number } {
  const required = d.fees.hurdle_multiple * (feeRt + spreadFrac / 2);
  return { ok: expectedMoveFrac >= required, required };
}

/**
 * Paper accounts are charged nothing by Alpaca, so we charge ourselves: fee + slippage, in cents (ceil).
 * This is what makes paper graduation honest (docs/RISK_DOCTRINE.md §7).
 */
export function modeledPaperCostCents(
  arena: Arena,
  side: "buy" | "sell",
  liquidity: Liquidity,
  notionalUsd: number,
  d: Doctrine,
): { feeCents: number; slippageCents: number; slippageBps: number } {
  const fee = notionalUsd * legFeeRate(arena, side, liquidity, notionalUsd, d);
  const slippageBps = d.fees.paper_slippage_bps[arena] ?? 25; // audit W3-02: an unknown arena never models zero cost
  const slip = (notionalUsd * slippageBps) / 10_000;
  return { feeCents: Math.ceil(fee * 100), slippageCents: Math.ceil(slip * 100), slippageBps };
}
