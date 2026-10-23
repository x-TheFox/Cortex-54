import type { AccountView, StatusView } from "./api.ts";

/**
 * ECAM logic: turns brain state into warnings (red), cautions (amber) and memos (green). Dark cockpit: when
 * this returns no warnings and no cautions, nothing on the screen should be lit except green memo lines.
 * Pure; the order of each list is its priority.
 */

export type Level = "warning" | "caution";

export interface Alert {
  id: string;
  level: Level;
  title: string; // the ECAM title line, e.g. "PAPER BREAKER YELLOW"
  detail: string;
  actions: string[]; // cyan action lines: what happens next or what the operator may do
  page: "ACCT" | "STS"; // the system page ECAM auto-calls for this alert
}

export interface Ecam {
  warnings: Alert[];
  cautions: Alert[];
  memos: string[];
}

const PULSE_LOST_MS = 8 * 60_000; // sentinel's STALE_ALERT_MINUTES
const PULSE_LATE_MS = 6 * 60_000;

function accountAlerts(a: AccountView): Alert[] {
  const out: Alert[] = [];
  const A = a.account;
  if (!a.configured) return out;
  if (a.locked || a.breaker === "RED") {
    out.push({
      id: `${A}-red`,
      level: "warning",
      page: "ACCT",
      title: `${A} RED LOCK`,
      detail: "Breaker tripped: positions flattened and entries locked.",
      actions:
        A === "PAPER"
          ? ["PAPER SELF-UNLOCKS 24 H AFTER FLAT", "OR UNLOCK WITH A WRITTEN POSTMORTEM"]
          : ["UNLOCK NEEDS A WRITTEN POSTMORTEM"],
    });
  } else if (a.breaker === "ORANGE") {
    out.push({
      id: `${A}-orange`,
      level: "caution",
      page: "ACCT",
      title: `${A} BREAKER ORANGE`,
      detail: "Drawdown 6–10% from the high-water mark: reduce-only.",
      actions: ["NEW ENTRIES BLOCKED UNTIL RECOVERY"],
    });
  } else if (a.breaker === "YELLOW") {
    out.push({
      id: `${A}-yellow`,
      level: "caution",
      page: "ACCT",
      title: `${A} BREAKER YELLOW`,
      detail: "Drawdown 3–6%: new positions sized at half risk.",
      actions: ["SIZING ×0.5 APPLIED AUTOMATICALLY"],
    });
  }
  if (a.mode === "REDUCE_ONLY") {
    out.push({
      id: `${A}-reduce`,
      level: "caution",
      page: "ACCT",
      title: `${A} REDUCE ONLY`,
      detail: a.modeReason ?? "Fail-closed: exits run, entries blocked.",
      actions: ["CLEARS ITSELF WHEN THE CONDITION RESOLVES"],
    });
  } else if (a.mode === "PAUSED") {
    out.push({
      id: `${A}-paused`,
      level: "caution",
      page: "ACCT",
      title: `${A} ENTRIES PAUSED`,
      detail: a.modeReason ?? "Paused by the operator.",
      actions: ["RESUME ON THE OVERHEAD PANEL"],
    });
  }
  if (a.lastError) {
    out.push({
      id: `${A}-err`,
      level: "caution",
      page: "ACCT",
      title: `${A} BROKER FAULT`,
      detail: a.lastError.slice(0, 140),
      actions: ["RETRIED EVERY PULSE"],
    });
  }
  return out;
}

export function ecam(s: StatusView, now: number): Ecam {
  const warnings: Alert[] = [];
  const cautions: Alert[] = [];
  const age = s.lastPulseAt === null ? Number.POSITIVE_INFINITY : now - s.lastPulseAt;
  if (age > PULSE_LOST_MS) {
    warnings.push({
      id: "pulse-lost",
      level: "warning",
      page: "STS",
      title: "BRAIN PULSE LOST",
      detail:
        s.lastPulseAt === null ? "No pulse recorded." : `Last pulse ${Math.round(age / 60_000)} min ago.`,
      actions: ["SENTINEL WATCHES INDEPENDENTLY", "KILL SWITCH: gh workflow run kill-switch"],
    });
  } else if (age > PULSE_LATE_MS) {
    cautions.push({
      id: "pulse-late",
      level: "caution",
      page: "STS",
      title: "BRAIN PULSE LATE",
      detail: `Last pulse ${Math.round(age / 1000)} s ago.`,
      actions: ["CRON SELF-HEAL RE-ARMS THE ALARM"],
    });
  }
  for (const a of s.accounts)
    for (const al of accountAlerts(a)) (al.level === "warning" ? warnings : cautions).push(al);
  if (s.budget.mode === "REDUCE_ONLY") {
    cautions.push({
      id: "budget-hard",
      level: "caution",
      page: "STS",
      title: "FREE TIER LIMIT",
      detail: `${s.budget.worst.resource} at ${Math.round(s.budget.worst.fraction * 100)}% of today's free allowance.`,
      actions: ["ENTRIES BLOCKED UNTIL 00:00 UTC"],
    });
  } else if (s.budget.mode === "THRIFT") {
    cautions.push({
      id: "budget-thrift",
      level: "caution",
      page: "STS",
      title: "BUDGET THRIFT",
      detail: `${s.budget.worst.resource} at ${Math.round(s.budget.worst.fraction * 100)}%.`,
      actions: ["CADENCE WIDENED AUTOMATICALLY"],
    });
  }
  for (const r of s.regimes) {
    if ((r.arena === "CRYPTO" || r.arena === "EQUITIES") && !r.fresh) {
      cautions.push({
        id: `stale-${r.arena}`,
        level: "caution",
        page: "STS",
        title: `${r.arena} REGIME STALE`,
        detail: `Last batch ${Math.round(r.ageMinutes / 60)} h ago.`,
        actions: ["ENTRIES IN THIS ARENA FAIL CLOSED", "BRAIN DISPATCHES THE RESEARCH JOB"],
      });
    }
  }
  if (s.outboxPending > 50) {
    cautions.push({
      id: "outbox",
      level: "caution",
      page: "STS",
      title: "JOURNAL BACKLOG",
      detail: `${s.outboxPending} rows waiting for D1.`,
      actions: ["FLUSHED EACH PULSE"],
    });
  }

  const memos: string[] = [];
  for (const a of s.accounts) {
    if (a.account === "LIVE" && (!a.configured || a.autonomyStop === 0)) memos.push("LIVE DORMANT");
    else if (!a.configured) memos.push(`${a.account} NOT CONFIGURED`);
    else if (a.mode === "NORMAL") memos.push(`${a.account} AUTO · STOP ${a.autonomyStop} · ${a.rung}`);
  }
  if (age <= PULSE_LATE_MS) memos.push(`PULSE ${Math.round(age / 1000)} S`);
  if (s.budget.mode === "NORMAL") memos.push(`BUDGET ${Math.round(s.budget.worst.fraction * 100)}%`);
  memos.push(`JOURNAL #${s.journalHead.seq}`);
  return { warnings, cautions, memos };
}

/** Drawdown from the high-water mark, as a fraction (0 when unknown). */
export function drawdown(a: AccountView): number {
  if (a.equityUsd === null || a.hwmUsd === null || a.hwmUsd <= 0) return 0;
  return Math.max(0, (a.hwmUsd - a.equityUsd) / a.hwmUsd);
}
