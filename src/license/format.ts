import { z } from "zod";

/**
 * The licence token format (ADR-077, ADR-086), shared by the app (checks it offline, node:crypto) and the licence
 * server (signs it, WebCrypto). Pure: no crypto here, only the exact bytes that get signed.
 *
 *   v1 — a publisher-issued file (scripts/license.ts): no machine, may be perpetual.
 *   v2 — issued by the licence server for a Whop licence key: bound to one machine, short-lived (it is refreshed
 *        while the purchase is active), and carries the Whop membership it came from.
 *
 * The kind string predates the rebrand and stays, so existing licence files keep verifying (docs/BRAND.md).
 */
export const LICENSE_KIND = "cortex-54-license";

const Base = z.object({
  kind: z.literal(LICENSE_KIND),
  id: z.string().min(6).max(64),
  licensee: z.string().min(1).max(120),
  plan: z.string().min(1).max(40),
  issued_at: z.string(),
  /** null = perpetual (v1 only in practice) */
  expires_at: z.string().nullable(),
  sig: z.string().max(200),
});

export const LicenseV1Schema = Base.extend({ v: z.literal(1) });
export const LicenseV2Schema = Base.extend({
  v: z.literal(2),
  /** the machine fingerprint this token is valid on (sha256, hex) */
  machine: z.string().regex(/^[0-9a-f]{32,64}$/),
  /** where it came from ("whop") and when the app should ask for a fresh one */
  source: z.string().min(1).max(20),
  refresh_after: z.string(),
});
export const LicenseSchema = z.discriminatedUnion("v", [LicenseV1Schema, LicenseV2Schema]);
export type License = z.infer<typeof LicenseSchema>;
export type LicenseBody = License extends infer L ? (L extends License ? Omit<L, "sig"> : never) : never;

/** The signed bytes: every field except `sig`, in a fixed order per version. */
export function licenseBody(l: LicenseBody): string {
  const head = [l.kind, l.v, l.id, l.licensee, l.plan, l.issued_at, l.expires_at];
  return JSON.stringify(l.v === 2 ? [...head, l.machine, l.source, l.refresh_after] : head);
}

/** What the activation endpoint accepts and returns. */
export const ActivateRequestSchema = z.object({
  key: z.string().trim().min(8).max(100),
  machine: z.string().regex(/^[0-9a-f]{32,64}$/),
  app: z.string().max(40).optional(),
  /** ADR-093: a readable name for this computer, shown on the account page ("MacBook Pro") */
  name: z.string().trim().max(60).optional(),
});
export type ActivateResponse =
  | { ok: true; license: License; message: string }
  | { ok: false; code: string; message: string };
