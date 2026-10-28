/**
 * Brokers Savant can trade through (ADR-078, MLP4-027). `BrokerApi` is the seam: the brain only ever talks to it, and
 * every adapter must pass the same conformance suite (test/broker-conformance.test.ts): idempotent client order ids,
 * lookups by client id, no selling more than is held (no shorting), cancels, fills reported as activities.
 *
 * A broker joins this list only after its adapter passes that suite AND a supervised paper session against the real
 * venue (orders, partial fills, stops, cancels, reconciliation), the same bar Alpaca cleared. An unverified adapter in
 * the order path would be trading on a guess (constitution U6), so candidates wait here, not in the code.
 */
export interface BrokerInfo {
  id: "alpaca" | "sandbox";
  name: string;
  arenas: ("CRYPTO" | "EQUITIES")[];
  /** a paper / sandbox mode with fake money exists (required for PAPER, and for the conformance session) */
  paper: boolean;
  /** broker-side stop orders (otherwise the brain's synthetic stop runs every pulse) */
  brokerStops: { CRYPTO: boolean; EQUITIES: boolean };
  /** smallest order the venue accepts, USD */
  minNotional: { CRYPTO: number; EQUITIES: number };
  verified: string;
}

export const BROKERS: readonly BrokerInfo[] = [
  {
    id: "alpaca",
    name: "Alpaca",
    arenas: ["CRYPTO", "EQUITIES"],
    paper: true,
    brokerStops: { CRYPTO: false, EQUITIES: true },
    minNotional: { CRYPTO: 10, EQUITIES: 1 },
    verified: "2026-10-24 (paper + live REST, ADR-042)",
  },
  {
    id: "sandbox",
    name: "Savant sandbox (simulated, live public crypto prices)",
    arenas: ["CRYPTO"],
    paper: true,
    brokerStops: { CRYPTO: false, EQUITIES: false },
    minNotional: { CRYPTO: 10, EQUITIES: 1 },
    verified: "2026-10-26 (local demo mode, ADR-064)",
  },
];

/** Venues considered and why each waits (kept honest in one place; docs/DECISIONS.md ADR-078). */
export const CANDIDATES: readonly { name: string; blocker: string }[] = [
  {
    name: "Coinbase Advanced Trade",
    blocker: "no paper mode; its sandbox is a static mock, so no supervised paper session is possible",
  },
  { name: "Kraken", blocker: "no paper mode for spot" },
  {
    name: "Tradier",
    blocker: "sandbox exists (equities, delayed data); needs an account to run the supervised paper session",
  },
  {
    name: "Interactive Brokers",
    blocker: "paper account exists; needs the Client Portal gateway running locally and an account",
  },
];
