/** Money and quantity helpers. Rounding is always conservative (CLAUDE.md §9). */

export const toCents = (usd: number): number => Math.round(usd * 100);
export const fromCents = (cents: number): number => cents / 100;

/** Parse an Alpaca decimal string; throws on garbage so bad broker data fails closed. */
export function dec(s: string | number | null | undefined, field = "value"): number {
  if (typeof s === "number") {
    if (!Number.isFinite(s)) throw new Error(`non-finite ${field}`);
    return s;
  }
  if (s === null || s === undefined || s === "") throw new Error(`missing ${field}`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`bad decimal ${field}: ${s}`);
  return n;
}

function decimalsOf(increment: number): number {
  const s = increment.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Floor `qty` to a multiple of `increment` and format it for the broker. Returns "0" if below one increment. */
export function floorToIncrement(qty: number, increment: number): string {
  if (!(increment > 0)) throw new Error("increment must be > 0");
  const steps = Math.floor(qty / increment + 1e-9);
  if (steps <= 0) return "0";
  return (steps * increment).toFixed(decimalsOf(increment));
}

/** Round a price to a tick in the conservative direction for the order side. */
export function roundPrice(price: number, tick: number, mode: "down" | "up"): string {
  const steps = mode === "down" ? Math.floor(price / tick + 1e-9) : Math.ceil(price / tick - 1e-9);
  return (steps * tick).toFixed(decimalsOf(tick));
}

/** Price tick heuristic: equities $0.01 (≥$1) / $0.0001 (<$1); crypto from asset metadata when known. */
export function defaultTick(price: number, arena: "CRYPTO" | "EQUITIES" | "OPTIONS"): number {
  if (arena === "EQUITIES") return price >= 1 ? 0.01 : 0.0001;
  if (price >= 1000) return 0.01;
  if (price >= 1) return 0.001;
  return 0.000001;
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const bps = (fraction: number): number => fraction * 10_000;
