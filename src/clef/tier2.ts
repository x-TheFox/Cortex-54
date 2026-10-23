import type { Doctrine } from "../contracts/doctrine.ts";
import type { Evidence } from "../court/evidence.ts";
import { evidenceForModels } from "../court/evidence.ts";
import { type ClefQuestion, type ClefResult, choice, noul, score } from "./ClefClient.ts";

/**
 * Tier 2 (CLAUDE.md §3): Clef 27B looks at one candidate's full Tier 0 evidence and decides whether it deserves
 * the court. Long-only. Pure build + interpret.
 */
export const TIER2_PROMPT_VERSION = "tier2@1";
export const QUALITY_LEVELS = ["Poor", "Weak", "Fair", "Strong", "Excellent"] as const;
export const SETUPS = {
  momentum_continuation: "Trend and catalyst agree; price above rising averages",
  breakout: "Catalyst pushes price through a recent range high on expanding range",
  pullback_buy: "Catalyst arrives on a pullback to support in an uptrend",
  news_fade: "Catalyst is already priced in or likely to reverse",
  no_trade: "No clean long setup",
} as const;

export function buildTier2(e: Evidence): { state: unknown; questions: Record<string, ClefQuestion> } {
  return {
    state: {
      task: "Decide if this catalyst deserves a full long-only trade review (crypto spot / fractional equities, 1–3 day holds, tiny account, fees matter).",
      evidence: evidenceForModels(e),
    },
    questions: {
      long_favored: {
        type: "noul",
        instructions:
          "Is a long position in the symbol favored over the next 72 hours given the catalyst, technicals and regime?",
      },
      regime_alignment: {
        type: "noul",
        instructions: "Does a long position align with the regime context provided?",
      },
      bear_lethality: {
        type: "noul",
        instructions:
          "Is there a likely fatal flaw for a long (already priced in, overextended vs ATR/EMA, event risk, poor liquidity)?",
      },
      setup_class: {
        type: "choice",
        instructions: "Which setup best describes this?",
        criteria: { ...SETUPS },
      },
      structural_quality: {
        type: "score",
        instructions: "Overall structural quality of a long here",
        criteria: [...QUALITY_LEVELS],
      },
    },
  };
}

export interface Tier2Decision {
  pass: boolean;
  longFavored: number;
  regimeAlignment: number;
  bearLethality: number;
  setup: string;
  quality100: number; // structural score mapped to 0..100
  reasons: string[];
}

/** Missing answers fail closed. */
export function interpretTier2(
  r: ClefResult,
  d: Doctrine,
  opts: { exception?: boolean } = {},
): Tier2Decision {
  // ADR-039: an exception-lane candidate is counter-regime by definition, so regime alignment is waived and
  // long_favored must clear the stricter exception bar instead.
  const passAt = opts.exception
    ? d.regime_gates.exception_lane.min_tier2_long_favored
    : d.funnel.tier2.pass_threshold;
  const lf = noul(r.answers.long_favored);
  const ra = noul(r.answers.regime_alignment);
  const bl = noul(r.answers.bear_lethality);
  const sc = choice(r.answers.setup_class);
  const q = score(r.answers.structural_quality);
  const reasons: string[] = [];
  if (lf === null || ra === null || bl === null || sc === null || q === null)
    reasons.push("incomplete Clef answers");
  const quality100 = q === null ? 0 : (q / (QUALITY_LEVELS.length - 1)) * 100;
  if ((lf ?? 0) < passAt) reasons.push(`long_favored ${(lf ?? 0).toFixed(2)} < ${passAt}`);
  if (!opts.exception && (ra ?? 0) < 0.5) reasons.push(`regime_alignment ${(ra ?? 0).toFixed(2)} < 0.5`);
  if (sc === "no_trade" || sc === "news_fade") reasons.push(`setup ${sc}`);
  if (quality100 < d.funnel.tier3.min_structural_score) {
    reasons.push(`quality ${quality100.toFixed(0)} < ${d.funnel.tier3.min_structural_score}`);
  }
  return {
    pass: reasons.length === 0,
    longFavored: lf ?? 0,
    regimeAlignment: ra ?? 0,
    bearLethality: bl ?? 1,
    setup: sc ?? "no_trade",
    quality100,
    reasons,
  };
}
