import type { Receipt } from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import { reputationKey } from "../risk/scar.ts";
import { atr, type Bar, ema, rsi } from "../strategy/indicators.ts";

/**
 * Tier 0 evidence (CLAUDE.md §3: all arithmetic is code). One fact sheet per candidate, shared by Tier 2, the bull,
 * the bear and the synth. Every number carries an evidence id so contract receipts can cite it. Pure.
 */
export type Arena = "CRYPTO" | "EQUITIES";

export interface Catalyst {
  candidateId: string;
  kind: string;
  headline: string;
  source: string;
  url: string | null;
  ageMinutes: number;
  tier1: { material: number; direction: string; escalate: number } | null;
}

export interface Evidence {
  symbol: string;
  arena: Arena;
  asOf: number;
  quote: { bid: number; ask: number; spread_bps: number };
  technicals: {
    close: number;
    atr14: number;
    atr_pct: number;
    ema20: number;
    ema50: number | null;
    rsi14: number | null;
    high20: number;
    low20: number;
    dist_ema20_pct: number;
    change_5d_pct: number;
  };
  regime: Record<string, unknown>;
  world: Record<string, unknown> | null;
  catalyst: Catalyst;
  portfolio: { held: string[] };
  /** ADR-039: true when this catalyst trades through the exception lane against a closed regime gate. */
  regimeException: boolean;
  /** Operator-merged scar lessons and decayed Governor beliefs (data, not instructions). ADR-033. */
  memory: { lessons: string[]; beliefs: string[] };
  receipts: Receipt[];
}

/** Map a candidate's symbols to a tradeable doctrine symbol (crypto "BTCUSD" → "BTC/USD"). First match wins. */
export function resolveTradeable(symbols: string[], d: Doctrine): { symbol: string; arena: Arena } | null {
  const crypto = new Set(d.watchlists.crypto ?? []);
  const equities = new Set([
    ...(d.watchlists.crypto_proxies ?? []),
    ...(d.watchlists.equities_core ?? []),
    ...(d.watchlists.equities_catalyst ?? []),
  ]);
  for (const raw of symbols) {
    const s = raw.toUpperCase();
    const slash = s.includes("/") ? s : s.endsWith("USD") && s.length > 3 ? `${s.slice(0, -3)}/USD` : s;
    if (crypto.has(slash)) return { symbol: slash, arena: "CRYPTO" };
    if (equities.has(s)) return { symbol: s, arena: "EQUITIES" };
  }
  return null;
}

const round = (x: number, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

export function buildEvidence(i: {
  symbol: string;
  arena: Arena;
  bars: Bar[];
  bid: number;
  ask: number;
  now: number;
  regime: Record<string, unknown>;
  world: Record<string, unknown> | null;
  catalyst: Catalyst;
  held: string[];
  memory?: { lessons: string[]; beliefs: string[] };
  regimeException?: boolean;
}): Evidence | null {
  const closes = i.bars.map((b) => b.c);
  const a = atr(i.bars, 14);
  const e20 = ema(closes, 20);
  const last = closes.at(-1);
  if (a === null || e20 === null || last === undefined || i.bars.length < 21 || !(i.bid > 0)) return null;
  const window = i.bars.slice(-21, -1);
  const high20 = Math.max(...window.map((b) => b.h));
  const low20 = Math.min(...window.map((b) => b.l));
  const c5 = closes.at(-6);
  const mid = (i.bid + i.ask) / 2;
  const t = {
    close: round(last, 6),
    atr14: round(a, 6),
    atr_pct: round(a / last, 5),
    ema20: round(e20, 6),
    ema50: ((x) => (x === null ? null : round(x, 6)))(ema(closes, 50)),
    rsi14: ((x) => (x === null ? null : round(x, 2)))(rsi(closes, 14)),
    high20: round(high20, 6),
    low20: round(low20, 6),
    dist_ema20_pct: round((i.bid - e20) / e20, 5),
    change_5d_pct: c5 ? round((last - c5) / c5, 5) : 0,
  };
  const receipts: Receipt[] = [
    {
      evidence_id: "close",
      source_skill: "technical-indicators",
      metric: "close",
      metric_value: t.close,
      as_of: i.now,
    },
    {
      evidence_id: "atr14",
      source_skill: "technical-indicators",
      metric: "atr14",
      metric_value: t.atr14,
      as_of: i.now,
    },
    {
      evidence_id: "ema20",
      source_skill: "technical-indicators",
      metric: "ema20",
      metric_value: t.ema20,
      as_of: i.now,
    },
    {
      evidence_id: "high20",
      source_skill: "technical-indicators",
      metric: "high20",
      metric_value: t.high20,
      as_of: i.now,
    },
    {
      evidence_id: "low20",
      source_skill: "technical-indicators",
      metric: "low20",
      metric_value: t.low20,
      as_of: i.now,
    },
    ...(t.rsi14 === null
      ? []
      : [
          {
            evidence_id: "rsi14",
            source_skill: "technical-indicators",
            metric: "rsi14",
            metric_value: t.rsi14,
            as_of: i.now,
          },
        ]),
    {
      evidence_id: "catalyst",
      source_skill: i.catalyst.kind === "news" ? "news-catalyst-sniper" : "gdelt-world-pulse",
      metric: "headline",
      metric_value: i.catalyst.headline.slice(0, 200),
      as_of: i.now,
      ...(i.catalyst.url ? { provenance_url: i.catalyst.url } : {}),
    },
    {
      evidence_id: "catalyst_source",
      source_skill: "intake",
      metric: "reputation_key",
      metric_value: reputationKey(i.catalyst.kind, i.catalyst.source),
      as_of: i.now,
    },
    ...(i.regimeException
      ? [
          {
            evidence_id: "regime_exception",
            source_skill: "exception-lane",
            metric: "regime_exception",
            metric_value: "exceptional catalyst against a closed regime gate (half size, ADR-039)",
            as_of: i.now,
          },
        ]
      : []),
  ];
  return {
    symbol: i.symbol,
    arena: i.arena,
    asOf: i.now,
    quote: { bid: i.bid, ask: i.ask, spread_bps: round(((i.ask - i.bid) / mid) * 10_000, 2) },
    technicals: t,
    regime: i.regime,
    world: i.world,
    catalyst: i.catalyst,
    portfolio: { held: i.held },
    memory: i.memory ?? { lessons: [], beliefs: [] },
    regimeException: i.regimeException ?? false,
    receipts,
  };
}

/** The JSON the models see (no receipts list; ids are named in the prompt). */
export function evidenceForModels(e: Evidence): Record<string, unknown> {
  const { receipts: _r, ...rest } = e;
  return { ...rest, evidence_ids: e.receipts.map((r) => r.evidence_id) };
}
