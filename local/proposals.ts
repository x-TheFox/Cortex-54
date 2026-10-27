import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Calibration, CalibrationSchema } from "../src/contracts/calibration.ts";
import { type ScarRule, ScarRuleSchema, ScarTissueSchema } from "../src/risk/scar.ts";
import { loadLocalScar, localScarPath } from "./memory.ts";

/**
 * Governor proposals on a customer's install (ADR-091, constitution U8). The weekly Governor writes what it would
 * change into <home>/proposals/; nothing applies until the user approves it here. This is the customer's version of
 * the publisher's pull request. Proposals can only tighten: calibration maps are re-validated as shrink-only
 * (CalibrationSchema) and scar rules are reject-only filters.
 */
const dir = (home: string) => join(home, "proposals");
const calProposal = (home: string) => join(dir(home), "calibration.json");
const scarProposal = (home: string) => join(dir(home), "scar-tissue.json");
/** the calibration the user approved (replaces the one built into the app) */
export const localCalibrationPath = (home: string) => join(home, "calibration.json");

const readJson = (p: string): unknown => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

export function loadLocalCalibration(home: string): Calibration | null {
  try {
    const raw = readJson(localCalibrationPath(home));
    return raw ? CalibrationSchema.parse(raw) : null;
  } catch {
    return null; // a damaged file never loosens anything: the built-in map is used instead
  }
}

export interface ProposalsView {
  calibration: {
    n: number;
    brierRaw: number | null;
    brierCalibrated: number | null;
    proposedAt: number | null;
  } | null;
  scars: { id: string; kind: string; rule: string }[];
}

function pendingCalibration(home: string): Calibration | null {
  try {
    const raw = readJson(calProposal(home));
    return raw ? CalibrationSchema.parse(raw) : null;
  } catch {
    return null;
  }
}

function pendingScars(home: string): ScarRule[] {
  const raw = readJson(scarProposal(home)) as { rules?: unknown[] } | null;
  return (raw?.rules ?? []).flatMap((r) => {
    const p = ScarRuleSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

export function readProposals(home: string): ProposalsView {
  const cal = pendingCalibration(home);
  const m = cal?.maps["court.win_prob"];
  return {
    calibration: m
      ? {
          n: m.n,
          brierRaw: m.brier_raw ?? null,
          brierCalibrated: m.brier_calibrated ?? null,
          proposedAt: cal.generated_at,
        }
      : null,
    scars: pendingScars(home).map((r) => ({ id: r.id, kind: r.kind, rule: r.rule })),
  };
}

export function decideProposal(
  home: string,
  q: { which: "calibration" | "scar"; approve: boolean; id?: string },
): { ok: boolean; message: string } {
  if (q.which === "calibration") {
    const cal = pendingCalibration(home);
    if (!cal) return { ok: false, message: "There is no calibration proposal waiting." };
    if (q.approve) writeFileSync(localCalibrationPath(home), `${JSON.stringify(cal, null, 2)}\n`);
    rmSync(calProposal(home), { force: true });
    return {
      ok: true,
      message: q.approve
        ? "Calibration approved. The court's confidence now follows your own track record."
        : "Calibration proposal dismissed.",
    };
  }
  const all = pendingScars(home);
  const pick = all.find((r) => r.id === q.id);
  if (!pick) return { ok: false, message: "That rule proposal isn't waiting any more." };
  if (q.approve) {
    const local = loadLocalScar(home);
    const next = ScarTissueSchema.parse({
      ...local,
      rules: [...local.rules.filter((r) => r.id !== pick.id), pick],
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(localScarPath(home), `${JSON.stringify(next, null, 2)}\n`);
  }
  const rest = all.filter((r) => r.id !== pick.id);
  if (rest.length)
    writeFileSync(scarProposal(home), `${JSON.stringify({ version: 1, rules: rest }, null, 2)}\n`);
  else rmSync(scarProposal(home), { force: true });
  return {
    ok: true,
    message: q.approve
      ? `Rule ${pick.id} approved: it now vetoes matching trades.`
      : `Rule ${pick.id} dismissed.`,
  };
}
