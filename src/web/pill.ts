import type { StatusView } from "../cortex/Brain.ts";

/**
 * The "pulse pill" (ADR-062): a tiny read-only status for desktop widgets (SwiftBar/xbar on macOS, the PowerShell
 * tray app on Windows) and anything else that wants one number. Auth: `authorization: Bearer <PILL_TOKEN>`, a
 * read-only secret separate from every other key. Formats: json (default), swiftbar (menu-bar text, so the macOS
 * plugin is a one-line curl with no dependencies), text.
 */

export interface Pill {
  ok: boolean;
  pulse_age_s: number | null;
  budget: string;
  accounts: {
    account: string;
    equity: number | null;
    positions: number;
    breaker: string;
    dial: number;
    mode: string;
  }[];
  regimes: { arena: string; posture: string; fresh: boolean }[];
  symbols: string[];
  /** ADR-076: local mode's one-line health problem for the tray (null = all well) */
  problem?: string | null;
}

export function pill(s: StatusView): Pill {
  const age = s.lastPulseAt === null ? null : Math.round((s.now - s.lastPulseAt) / 1000);
  return {
    ok: age !== null && age < 900,
    pulse_age_s: age,
    budget: String((s.budget as { mode?: string }).mode ?? "?"),
    accounts: s.accounts
      .filter((a) => a.configured)
      .map((a) => ({
        account: a.account,
        equity: a.equityUsd,
        positions: (a.positions ?? []).length,
        breaker: a.breaker,
        dial: a.autonomyStop,
        mode: a.mode,
      })),
    regimes: s.regimes.map((r) => ({ arena: r.arena, posture: r.posture, fresh: r.fresh })),
    symbols: [
      ...new Set(
        s.accounts.filter((a) => a.configured).flatMap((a) => (a.positions ?? []).map((p) => p.symbol)),
      ),
    ],
  };
}

export function swiftbar(p: Pill, terminalUrl: string): string {
  const paper = p.accounts.find((a) => a.account === "PAPER");
  const dot = !p.ok
    ? "🔴"
    : p.accounts.some((a) => a.breaker !== "GREEN" || a.mode !== "NORMAL")
      ? "🟡"
      : "🟢";
  const head = `${dot} C54 ${paper?.equity === null || paper?.equity === undefined ? "—" : `$${paper.equity.toFixed(2)}`} · ${p.symbols.length}`;
  const lines = [
    head,
    "---",
    `Pulse ${p.pulse_age_s === null ? "never" : `${p.pulse_age_s}s ago`} · budget ${p.budget}`,
    ...(p.problem ? [`⚠️ ${p.problem} | color=orange`] : []),
    ...p.accounts.map(
      (a) =>
        `${a.account}: ${a.equity === null ? "—" : `$${a.equity.toFixed(2)}`} · ${a.positions} pos · ${a.breaker} · dial ${a.dial} · ${a.mode}`,
    ),
    ...p.regimes.map((r) => `${r.arena}: ${r.posture}${r.fresh ? "" : " (stale)"}`),
    p.symbols.length ? `Holding: ${p.symbols.join(", ")}` : "Flat",
    "---",
    `Open web terminal | href=${terminalUrl}`,
    "Refresh | refresh=true",
  ];
  return `${lines.join("\n")}\n`;
}

/** Constant-time compare of the bearer token. */
export function pillAuthorized(header: string | null, token: string | undefined): boolean {
  if (!token || token.length < 24 || !header?.startsWith("Bearer ")) return false;
  const got = header.slice(7);
  if (got.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
