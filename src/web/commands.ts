import type { AccountId } from "../lib/ids.ts";

/**
 * Operator commands shared by Discord and the web terminal (Phase 6 exit: every control has parity).
 * Status is rendered by each front end; everything else returns the brain's one-line answer.
 */
export const OPERATOR_COMMANDS = ["status", "pause", "resume", "dial", "unlock", "flatten", "court"] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export interface CommandArgs {
  account?: string | undefined;
  stop?: number | undefined;
  confirm?: string | undefined;
  postmortem?: string | undefined;
  symbol?: string | undefined;
}

/** The DO stub surface the runner needs (the real stub and test fakes both satisfy it). */
export interface OperatorBrain {
  pause(account: AccountId, by: string): Promise<string> | string;
  resume(account: AccountId, by: string): Promise<string> | string;
  setDial(account: AccountId, stop: number, by: string, ratified: boolean): Promise<string> | string;
  unlock(account: AccountId, postmortem: string, by: string): Promise<string> | string;
  flatten(account: AccountId, by: string): Promise<string>;
  court(symbol: string, by: string): Promise<string>;
}

const asAccount = (a: unknown): AccountId | null => (a === "PAPER" || a === "LIVE" ? a : null);

export async function runCommand(
  b: OperatorBrain,
  name: string,
  args: CommandArgs,
  by: string,
): Promise<{ ok: boolean; message: string }> {
  const account = asAccount(args.account);
  const needAccount = { ok: false, message: "Pick an account (PAPER or LIVE)." };
  switch (name) {
    case "pause":
      return account ? { ok: true, message: await b.pause(account, by) } : needAccount;
    case "resume":
      return account ? { ok: true, message: await b.resume(account, by) } : needAccount;
    case "dial": {
      const stop = Number(args.stop);
      if (!account || !Number.isInteger(stop) || stop < 0 || stop > 4)
        return { ok: false, message: "Pick an account and a stop 0–4." };
      return { ok: true, message: await b.setDial(account, stop, by, args.confirm === "RATIFY") };
    }
    case "unlock":
      return account
        ? { ok: true, message: await b.unlock(account, String(args.postmortem ?? ""), by) }
        : needAccount;
    case "flatten":
      return account ? { ok: true, message: await b.flatten(account, by) } : needAccount;
    case "court": {
      const symbol = String(args.symbol ?? "")
        .trim()
        .toUpperCase();
      if (!/^[A-Z.]{1,8}(\/USD)?$/.test(symbol))
        return { ok: false, message: "Give a symbol, e.g. BTC/USD or NVDA." };
      return { ok: true, message: await b.court(symbol, by) };
    }
    default:
      return { ok: false, message: `Unknown command ${name}` };
  }
}
