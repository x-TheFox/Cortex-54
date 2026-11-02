/**
 * Audit UX-03/05/10, MKT-07: one answer to "is Savant ready to trade, and if not, why?", computed from every gate that
 * can hold new entries, in the order a user should fix them. Shown by the setup wizard's last screen, the cockpit
 * banner and the FEED, so all three say the same thing. Pure: the caller gathers the facts.
 */

export type ReadyFix = "license" | "terms" | "models" | "account" | "controls" | null;

export interface ReadinessInput {
  /** the local kill switch file exists */
  killed: boolean;
  /** licence: required on a licensed build; ok when valid */
  license: { required: boolean; ok: boolean; reason?: string | null };
  /** paper or live mode (the demo needs no licence or terms) */
  realAccount: boolean;
  termsAccepted: boolean;
  /** the court has at least one usable model */
  modelsOk: boolean;
  /** the PAPER account as the brain sees it (null until the first pulse) */
  account: { mode: string; modeReason: string | null; locked: boolean; reconciledAt: number | null } | null;
  /** no pulse yet, or no regime data yet: the first market scan is still running */
  warmingUp: boolean;
}

export interface Readiness {
  ready: boolean;
  /** short headline: "Ready to trade" or what holds new trades */
  headline: string;
  /** one sentence: why, and what to do */
  detail: string;
  fix: ReadyFix;
  /** amber = held until the user acts; info = will clear by itself */
  level: "ok" | "info" | "amber";
}

export function readiness(i: ReadinessInput): Readiness {
  const held = (headline: string, detail: string, fix: ReadyFix, level: "info" | "amber" = "amber") => ({
    ready: false,
    headline,
    detail,
    fix,
    level,
  });
  if (i.killed)
    return held(
      "Kill switch is on",
      "No new trades until you re-arm it (Settings → Controls). Open positions keep their stops.",
      "controls",
    );
  if (i.realAccount && i.license.required && !i.license.ok)
    return held(
      "No licence: Savant won't open new trades",
      `${i.license.reason ?? "This computer has no valid licence."} Fix it in Settings → Licence. Open positions keep their stops.`,
      "license",
    );
  if (i.realAccount && !i.termsAccepted)
    return held(
      "Accept the terms first",
      "Savant trades your account only after you accept the terms.",
      "terms",
    );
  if (!i.modelsOk)
    return held(
      "Rule-based trades only: add an AI model",
      "The rule-based strategies still trade, but the court needs at least one AI model for everything else (Settings → AI models; free ones work).",
      "models",
    );
  const a = i.account;
  if (a?.locked)
    return held(
      "Locked after a big loss",
      a.modeReason ?? "The loss lock holds new trades until it clears.",
      "controls",
    );
  if (i.warmingUp || !a || a.reconciledAt === null)
    return held(
      "Getting ready",
      "The first market scan is running. Your robot starts looking for trades after it, usually within a few minutes.",
      null,
      "info",
    );
  if (a.mode !== "NORMAL") {
    const why = a.modeReason ?? "a safety check";
    const margin = /margin/i.test(why);
    return held(
      margin ? "The account allows borrowing" : "New trades are on hold",
      margin
        ? "Savant never borrows. Make the account cash-only (Settings → Trading account); paper accounts are switched automatically."
        : `Held by: ${why}. It clears by itself when the condition does.`,
      margin ? "account" : null,
      margin ? "amber" : "info",
    );
  }
  return {
    ready: true,
    headline: "Ready to trade",
    detail: "Every check passes. Savant opens trades on its own when it finds one worth taking.",
    fix: null,
    level: "ok",
  };
}
