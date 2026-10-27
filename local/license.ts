import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Licences (ADR-077, PSS-029…036). A licence is a small JSON file signed with the publisher's Ed25519 key; the app
 * checks it offline against the public key built into it. There is no phone-home and no obfuscation: the point is a
 * clear, honest gate for a paid product, not DRM.
 *
 * Safety first: without a valid licence the app never does anything unsafe. Demo mode always works. Paper mode keeps
 * running but with the kill switch's semantics (no new entries; every open position keeps its stop and exits), so an
 * expired licence can never strand a position without protection.
 *
 * Builds made without a publisher key (`CORTEX_LICENSE_PUBKEY` unset at build time, e.g. this public repo's own
 * builds and source checkouts) don't check licences at all.
 */

export const LicenseSchema = z.object({
  kind: z.literal("cortex-54-license"),
  v: z.literal(1),
  id: z.string().min(6).max(64),
  licensee: z.string().min(1).max(120),
  plan: z.string().min(1).max(40),
  issued_at: z.string(),
  /** null = perpetual */
  expires_at: z.string().nullable(),
  sig: z.string(),
});
export type License = z.infer<typeof LicenseSchema>;

/** The publisher key this build trusts (base64 SPKI DER), injected by the release build; empty = licences off. */
export const BUILT_IN_PUBKEY = process.env.CORTEX_LICENSE_PUBKEY_BUILTIN ?? "";

export type LicenseState =
  | { required: false }
  | { required: true; ok: true; license: Omit<License, "sig">; daysLeft: number | null }
  | { required: true; ok: false; reason: string };

/** The signed bytes: every field except `sig`, in a fixed order. */
export function licenseBody(l: Omit<License, "sig">): string {
  return JSON.stringify([l.kind, l.v, l.id, l.licensee, l.plan, l.issued_at, l.expires_at]);
}

export function checkLicense(raw: unknown, pubkeyB64: string, now = Date.now()): LicenseState {
  if (!pubkeyB64) return { required: false };
  if (raw === null || raw === undefined)
    return { required: true, ok: false, reason: "No licence installed." };
  const p = LicenseSchema.safeParse(raw);
  if (!p.success) return { required: true, ok: false, reason: "The licence file is not valid." };
  const { sig, ...body } = p.data;
  let good = false;
  try {
    const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
    good = verify(null, Buffer.from(licenseBody(body)), key, Buffer.from(sig, "base64"));
  } catch {
    good = false;
  }
  if (!good) return { required: true, ok: false, reason: "The licence signature doesn't match this app." };
  const exp = body.expires_at ? Date.parse(body.expires_at) : null;
  if (exp !== null && !(exp > now))
    return { required: true, ok: false, reason: `The licence expired on ${body.expires_at?.slice(0, 10)}.` };
  return {
    required: true,
    ok: true,
    license: body,
    daysLeft: exp === null ? null : Math.floor((exp - now) / 86_400_000),
  };
}

export const licensePath = (home: string) => join(home, "license.json");

export function readLicense(home: string, pubkey = BUILT_IN_PUBKEY, now = Date.now()): LicenseState {
  if (!pubkey) return { required: false };
  const p = licensePath(home);
  if (!existsSync(p)) return checkLicense(null, pubkey, now);
  try {
    return checkLicense(JSON.parse(readFileSync(p, "utf8")), pubkey, now);
  } catch {
    return { required: true, ok: false, reason: "The licence file can't be read." };
  }
}

export function installLicense(home: string, text: string, pubkey = BUILT_IN_PUBKEY): LicenseState {
  const raw = JSON.parse(text) as unknown;
  const st = checkLicense(raw, pubkey);
  if (st.required && !st.ok) throw new Error(st.reason);
  writeFileSync(licensePath(home), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return st;
}

/** True when trading must be held to exits only (paper mode without a valid licence on a licensed build). */
export const entriesBlocked = (st: LicenseState) => st.required && !st.ok;

// ------------------------------------------------------------------ publisher side (scripts/license.ts)

export function publisherKeygen(): { privateKeyPem: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export function issueLicense(
  privateKeyPem: string,
  o: { id: string; licensee: string; plan: string; days: number | null; now?: Date },
): License {
  const now = o.now ?? new Date();
  const body: Omit<License, "sig"> = {
    kind: "cortex-54-license",
    v: 1,
    id: o.id,
    licensee: o.licensee,
    plan: o.plan,
    issued_at: now.toISOString(),
    expires_at: o.days === null ? null : new Date(now.getTime() + o.days * 86_400_000).toISOString(),
  };
  const sig = sign(null, Buffer.from(licenseBody(body)), createPrivateKey(privateKeyPem)).toString("base64");
  return { ...body, sig };
}
