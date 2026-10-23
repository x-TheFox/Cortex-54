import { z } from "zod";
import { type ClefQuestion, type ClefResult, noul, score } from "../clef/ClefClient.ts";
import { applyMap, type CalibrationMap } from "../contracts/calibration.ts";
import type { DecisionContract } from "../contracts/decision-contract.ts";
import type { Doctrine } from "../contracts/doctrine.ts";
import { roundPrice } from "../lib/num.ts";
import { legFeeRate } from "../risk/fees.ts";
import { type Evidence, evidenceForModels } from "./evidence.ts";
import { BEAR_PROMPT_VERSION, BULL_PROMPT_VERSION } from "./prompts.ts";

/**
 * Tier 3 court (pure parts). Models argue; code checks every number against Tier 0 evidence and assembles the
 * DecisionContract. Nothing here sizes a position (constitution U2).
 */
export const BullSchema = z.object({
  no_trade: z.boolean(),
  thesis: z.string().min(1).max(600),
  setup: z.enum(["momentum_continuation", "breakout", "pullback_buy", "news_fade", "no_trade"]),
  entry_low: z.number().positive(),
  entry_high: z.number().positive(),
  stop: z.number().positive(),
  targets: z.array(z.number().positive()).min(1).max(3),
  horizon_hours: z
    .number()
    .int()
    .min(6)
    .max(24 * 7),
  conviction: z.number().int().min(1).max(10),
  receipts: z.array(z.string()).max(12),
});
export type Bull = z.infer<typeof BullSchema>;

export const BearSchema = z.object({
  fatal_flaws: z.array(z.string().min(3).max(400)).min(1).max(6),
  kill_criteria: z.array(z.string().min(5).max(300)).min(1).max(5),
  lethality: z.number().min(0).max(1),
  brief: z.string().min(20).max(2000),
});
export type Bear = z.infer<typeof BearSchema>;

export type BullCheck = { ok: true; bull: Bull; notes: string[] } | { ok: false; reasons: string[] };

/** Code wins: reject or repair a bull brief whose numbers don't fit the evidence (CLAUDE.md §5 errata). */
export function checkBull(b: Bull, e: Evidence, d: Doctrine): BullCheck {
  if (b.no_trade || b.setup === "no_trade") return { ok: false, reasons: ["bull declined (no_trade)"] };
  const r: string[] = [];
  const notes: string[] = [];
  const bid = e.quote.bid;
  const atr = e.technicals.atr14;
  if (!(b.entry_low <= b.entry_high)) r.push("entry_low > entry_high");
  if (bid < b.entry_low * 0.995 || bid > b.entry_high * 1.005) r.push("entry zone does not bracket the bid");
  if (!(b.stop < b.entry_low)) r.push("stop not below entry");
  if (b.entry_low - b.stop < d.sizing.min_stop_atr_multiple * atr)
    r.push(`stop closer than ${d.sizing.min_stop_atr_multiple}×ATR`);
  if ((b.entry_high - b.stop) / b.entry_high > 0.25) r.push("stop more than 25% away");
  const maxMove = 3 * atr * Math.sqrt(b.horizon_hours / 24);
  const targets = [...b.targets].sort((x, y) => x - y).filter((t) => t > b.entry_high);
  if (targets.length === 0) r.push("no target above the entry zone");
  const clipped = targets.map((t) => Math.min(t, b.entry_high + maxMove));
  if (clipped.some((t, i) => t !== targets[i]))
    notes.push(`targets clipped to entry + 3·ATR·√(h/24) = ${maxMove.toFixed(4)}`);
  if (r.length > 0) return { ok: false, reasons: r };
  return { ok: true, bull: { ...b, targets: [...new Set(clipped)].slice(0, 3) }, notes };
}

export const SYNTH_PROMPT_VERSION = "synth@1";
export const SUITABILITY = ["Very low", "Low", "Moderate", "High", "Very high"] as const;

export function buildSynth(
  e: Evidence,
  bull: Bull,
  bear: Bear,
): { state: unknown; questions: Record<string, ClefQuestion> } {
  return {
    state: {
      task: "Judge a long trade after a bull/bear debate. Prices in the bull brief were checked against the evidence by code.",
      evidence: evidenceForModels(e),
      bull: {
        thesis: bull.thesis,
        setup: bull.setup,
        entry: [bull.entry_low, bull.entry_high],
        stop: bull.stop,
        targets: bull.targets,
        horizon_hours: bull.horizon_hours,
      },
      bear: {
        fatal_flaws: bear.fatal_flaws,
        kill_criteria: bear.kill_criteria,
        brief: bear.brief.slice(0, 1200),
      },
    },
    questions: {
      win_prob: {
        type: "noul",
        instructions: "Will price reach the bull's first target before its stop within the horizon?",
      },
      regime_fit: { type: "noul", instructions: "Does this long fit the regime context provided?" },
      bear_lethality: {
        type: "noul",
        instructions: "Is the bear's strongest argument likely correct, so the long fails?",
      },
      suitability: {
        type: "score",
        instructions: "Overall suitability of taking this long now",
        criteria: [...SUITABILITY],
      },
    },
  };
}

export interface Synth {
  winProb: number;
  regimeFit: number;
  bearLethality: number;
  suitability100: number;
}

export function interpretSynth(r: ClefResult): Synth | null {
  const w = noul(r.answers.win_prob);
  const f = noul(r.answers.regime_fit);
  const b = noul(r.answers.bear_lethality);
  const s = score(r.answers.suitability);
  if (w === null || f === null || b === null || s === null) return null;
  return { winProb: w, regimeFit: f, bearLethality: b, suitability100: (s / (SUITABILITY.length - 1)) * 100 };
}

/**
 * Calibration (ADR-008): until enough outcomes exist, shrink toward 0.5 with weight max(warmup, n/min_outcomes).
 * Isotonic maps from the Governor replace this once config/calibration.json has one for "court.win_prob".
 */
export function calibrate(
  raw: number,
  resolvedOutcomes: number,
  d: Doctrine,
  map?: CalibrationMap | null,
): number {
  const c = d.funnel.calibration;
  if (map && map.n >= c.min_outcomes_before_trusting) return applyMap(map, raw);
  const w = Math.max(c.warmup_min_weight, Math.min(1, resolvedOutcomes / c.min_outcomes_before_trusting));
  return c.shrink_to + (raw - c.shrink_to) * w;
}

export const COURT_STRATEGY: Record<"CRYPTO" | "EQUITIES", string> = {
  CRYPTO: "CRYPTO_CATALYST_COURT_V1",
  EQUITIES: "EQUITY_CATALYST_COURT_V1",
};

export function buildCourtContract(i: {
  contractId: string;
  now: number;
  evidence: Evidence;
  bull: Bull;
  bear: Bear;
  synth: Synth;
  calibratedWin: number;
  tick: number;
  models: {
    bull: { provider: string; model: string; family: string };
    bear: { provider: string; model: string; family: string };
  };
  d: Doctrine;
}): DecisionContract {
  const { evidence: e, bull, bear, synth } = i;
  const px = (x: number, mode: "down" | "up") => roundPrice(x, i.tick, mode);
  const cited = new Set(bull.receipts);
  // The catalyst and its source always travel with the contract (Governor attribution, scar facts — ADR-033).
  const receipts = e.receipts.filter(
    (r) =>
      cited.has(r.evidence_id) ||
      r.evidence_id === "catalyst" ||
      r.evidence_id === "catalyst_source" ||
      r.evidence_id === "regime_exception",
  );
  const notional = 18;
  const entryFee = legFeeRate(e.arena, "buy", "maker", notional, i.d);
  const exitFee = legFeeRate(e.arena, "sell", "taker", notional, i.d);
  return {
    contract_id: i.contractId,
    created_at: i.now,
    schema_version: 1,
    origin: "COURT",
    symbol: e.symbol,
    arena: e.arena,
    strategy_id: COURT_STRATEGY[e.arena],
    thesis_summary: (bull.thesis.length >= 20
      ? bull.thesis
      : `${bull.thesis} — ${e.catalyst.headline}`
    ).slice(0, 280),
    bull_case_receipts: receipts.length > 0 ? receipts : e.receipts.slice(0, 3),
    bear_case_brief: `${bear.brief}`.slice(0, 1200).padEnd(20, "."),
    kill_criteria: bear.kill_criteria.map((k) => k.slice(0, 300)),
    invalidation_criteria: {
      stop_price: px(bull.stop, "down"),
      max_hold_hours: Math.min(bull.horizon_hours, 24 * 7),
      regime_trigger: e.arena === "CRYPTO" ? "crypto composite < 40" : "equity posture not NEW_ENTRY_ALLOWED",
    },
    entry_plan: {
      zone_low: px(bull.entry_low, "down"),
      zone_high: px(bull.entry_high, "up"),
      urgency: "NORMAL",
      targets: bull.targets.map((t) => px(t, "down")),
    },
    clef_probabilities: {
      raw: {
        win_prob: synth.winProb,
        regime_fit_prob: synth.regimeFit,
        bear_lethality_prob: synth.bearLethality,
      },
      calibrated_win_prob: i.calibratedWin,
      composite_suitability_score: synth.suitability100,
    },
    win_prob_used: i.calibratedWin,
    bear_lethality: Math.max(0, Math.min(1, (synth.bearLethality + bear.lethality) / 2)),
    atr: e.technicals.atr14,
    cost_and_fee_drag: {
      entry_fee_bps: Math.round(entryFee * 10_000 * 10) / 10,
      exit_fee_bps: Math.round(exitFee * 10_000 * 10) / 10,
      expected_slippage_bps: i.d.fees.paper_slippage_bps[e.arena] ?? 0,
      cognitive_cost_usd: 0,
    },
    proposed_conviction: bull.conviction,
    models_used: [
      { role: "BULL", ...i.models.bull, prompt_version: BULL_PROMPT_VERSION },
      { role: "BEAR", ...i.models.bear, prompt_version: BEAR_PROMPT_VERSION },
      {
        role: "SYNTH",
        provider: "workers-ai",
        model: "@cf/cloudflare/clef",
        family: "cloudflare-clef",
        prompt_version: SYNTH_PROMPT_VERSION,
      },
    ],
  };
}
