/** UUIDv7 (RFC 9562): 48-bit ms timestamp + random. Time-ordered, used for contract_id. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type AccountId = "PAPER" | "LIVE";
export type OrderRole = "ENTRY" | "STOP" | "EXIT";

/**
 * Idempotent client_order_id: c54-{P|L}-{contract8}-{E|S|X}-{attempt} (Entry, Stop, eXit). Re-submitting the same intent reuses the
 * id, and Alpaca rejects duplicates, so a retried POST can never double-fill.
 */
export function clientOrderId(
  account: AccountId,
  contractId: string,
  role: OrderRole,
  attempt: number,
): string {
  const short = contractId.replace(/-/g, "").slice(-8);
  const letter = role === "ENTRY" ? "E" : role === "STOP" ? "S" : "X";
  return `c54-${account === "PAPER" ? "P" : "L"}-${short}-${letter}-${attempt}`;
}

/** Canonical symbols: crypto always "BASE/QUOTE". Alpaca positions report crypto as "BTCUSD". */
export function canonicalSymbol(symbol: string, assetClass?: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("/")) return s;
  if (assetClass === "crypto") {
    for (const quote of ["USDT", "USDC", "USD", "BTC"]) {
      if (s.endsWith(quote) && s.length > quote.length) return `${s.slice(0, -quote.length)}/${quote}`;
    }
  }
  return s;
}

export const isCryptoSymbol = (symbol: string): boolean => symbol.includes("/");
