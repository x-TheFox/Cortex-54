import type { AlpacaAsset } from "../broker/types.ts";
import type { Constitution } from "../contracts/constitution.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import type { Arena } from "../risk/fees.ts";
import { atr, type Bar } from "../strategy/indicators.ts";

/**
 * Dynamic universe screen (ADR-058). Any Alpaca asset may join the tradeable universe, but only through this pure
 * code check: tradable and active, a real price, enough dollar volume, a tight spread, fractionable stocks (a $10–18
 * position), no OTC listing, no stablecoin, and no leveraged or inverse product unless the constitution names it
 * (U3: cash only, no leveraged products). Unknown facts fail the screen; it never fails open.
 */

export type UniverseArena = Extract<Arena, "CRYPTO" | "EQUITIES">;

export interface ScreenInput {
  symbol: string;
  arena: UniverseArena;
  asset: AlpacaAsset | null;
  bars: Bar[] | undefined;
  quote: { bid: number; ask: number } | undefined;
}

export interface ScreenResult {
  ok: boolean;
  reasons: string[];
  metrics: {
    price: number | null;
    dollar_volume_usd: number | null;
    spread_bps: number | null;
    atr_pct: number | null;
  };
}

const STABLECOINS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "PYUSD",
  "USDG",
  "TUSD",
  "BUSD",
  "FDUSD",
  "USDP",
  "GUSD",
  "USDE",
]);

/** Names of leveraged, inverse and volatility products. Matched on the asset name Alpaca returns. */
const LEVERAGED = [
  /\b[1-5](?:\.\d)?x\b/i, // 2X, 3x, 1.5x, -1x (the minus is checked below)
  /\bultra(?:pro|short)?\b/i,
  /\bleveraged?\b/i,
  /\binverse\b/i,
  /\bshort\b.*\b(?:etf|fund|shares|etn)\b/i,
  /\bbear\b.*\b(?:etf|shares|fund|etn)\b/i,
  /\bbull\b.*\b[1-5]x\b/i,
  /\bdaily\b.*\b(?:bull|bear|long|short)\b/i,
  /\bvix\b|\bvolatility\b/i,
];

export function isStablecoin(symbol: string): boolean {
  const base = symbol.toUpperCase().split("/")[0] ?? "";
  return STABLECOINS.has(base);
}

/**
 * True when the name looks like a leveraged, inverse or volatility product. The constitution's 1x inverse ETFs are
 * exempt (ADR-040). A missing name counts as leveraged for ETFs we can't identify: fail closed.
 */
export function isLeveragedOrInverse(
  symbol: string,
  name: string | null | undefined,
  c: Constitution,
): boolean {
  if ((c.allowed.inverse_etfs_1x ?? []).includes(symbol)) return false;
  const n = (name ?? "").trim();
  if (!n) return false; // no name: decided by the caller (crypto has no names worth checking)
  return LEVERAGED.some((r) => r.test(n));
}

/** Normalize a news/operator symbol: "BTCUSD" → "BTC/USD", "brk.b" → "BRK.B". Null when it can't be a symbol. */
export function normalizeSymbol(raw: string): { symbol: string; arena: UniverseArena } | null {
  const s = raw.trim().toUpperCase();
  if (/^[A-Z0-9]{2,10}\/USD$/.test(s)) return { symbol: s, arena: "CRYPTO" };
  if (/^[A-Z0-9]{2,10}USD$/.test(s) && s.length > 5)
    return { symbol: `${s.slice(0, -3)}/USD`, arena: "CRYPTO" };
  if (/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(s)) return { symbol: s, arena: "EQUITIES" };
  return null;
}

export function screenAsset(i: ScreenInput, d: Doctrine, c: Constitution): ScreenResult {
  const u = d.universe;
  const r: string[] = [];
  const bars = i.bars ?? [];
  const last = bars.at(-1)?.c ?? null;
  const window = bars.slice(-20);
  const dollarVolume = window.length >= 10 ? window.reduce((s, b) => s + b.c * b.v, 0) / window.length : null;
  const mid = i.quote ? (i.quote.bid + i.quote.ask) / 2 : null;
  const spreadBps =
    i.quote && mid && mid > 0 && i.quote.bid > 0 ? ((i.quote.ask - i.quote.bid) / mid) * 10_000 : null;
  const a14 = bars.length >= 15 ? atr(bars, 14) : null;
  const metrics = {
    price: last,
    dollar_volume_usd: dollarVolume === null ? null : Math.round(dollarVolume),
    spread_bps: spreadBps === null ? null : Math.round(spreadBps * 10) / 10,
    atr_pct: a14 && last ? Math.round((a14 / last) * 10_000) / 100 : null,
  };
  const a = i.asset;
  if (!a) r.push("no asset record at the broker");
  else {
    if (!a.tradable || a.status !== "active") r.push("not tradable/active at the broker");
    const cls = (a.class ?? "").toLowerCase();
    if (i.arena === "CRYPTO" ? cls !== "crypto" : cls !== "us_equity") r.push(`asset class ${a.class}`);
    if (i.arena === "EQUITIES") {
      if (!a.fractionable) r.push("not fractionable (positions here are $10–18)");
      const ex = (a.exchange ?? "").toUpperCase();
      if (!ex || ex === "OTC") r.push(`exchange ${ex || "unknown"}`);
      if (isLeveragedOrInverse(i.symbol, a.name, c)) r.push("leveraged, inverse or volatility product");
      if (!a.name) r.push("no asset name (can't rule out a leveraged product)");
    }
  }
  if (i.arena === "CRYPTO" && isStablecoin(i.symbol)) r.push("stablecoin");
  if (bars.length < 30) r.push(`only ${bars.length} daily bars (need 30)`);
  if (last === null || !(last > 0)) r.push("no price");
  else if (i.arena === "EQUITIES" && last < u.min_price_usd)
    r.push(`price $${last} below $${u.min_price_usd}`);
  const minDv = u.min_dollar_volume_usd[i.arena] ?? 0;
  if (dollarVolume === null) r.push("dollar volume unknown");
  else if (dollarVolume < minDv)
    r.push(
      `20-day dollar volume $${Math.round(dollarVolume).toLocaleString("en-US")} below $${minDv.toLocaleString("en-US")}`,
    );
  const maxSpread = u.max_spread_bps[i.arena] ?? 0;
  if (spreadBps === null) r.push("no two-sided quote");
  else if (spreadBps > maxSpread) r.push(`spread ${spreadBps.toFixed(0)} bps above ${maxSpread}`);
  return { ok: r.length === 0, reasons: r, metrics };
}
