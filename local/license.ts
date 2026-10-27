import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type ActivateResponse,
  LICENSE_KIND,
  type License,
  type LicenseBody,
  LicenseSchema,
  licenseBody,
} from "../src/license/format.ts";
import { machineId } from "./machine.ts";

/**
 * Licences (ADR-077, ADR-086). A licence is a small JSON token signed with the publisher's Ed25519 key; the app
 * checks it offline against the public key built into it. Two ways to get one:
 *   - a licence key bought on Whop: the app sends it (with this machine's fingerprint) to the licence server, which
 *     checks the purchase with Whop and returns a v2 token bound to this machine, valid for 14 days and refreshed
 *     daily while the purchase is active — so the app keeps working offline for up to two weeks;
 *   - a publisher-issued file (scripts/license.ts): v1, may be perpetual.
 *
 * Safety first: without a valid licence the app never does anything unsafe. Demo mode always works. Paper and live
 * keep running with the kill switch's semantics (no new entries; every open position keeps its stop and exits), so
 * a lapsed licence can never strand a position without protection.
 *
 * Builds made without a publisher key (`CORTEX_LICENSE_PUBKEY` unset at build time, e.g. source checkouts) don't
 * check licences at all.
 */

export type { License };
export { LicenseSchema, licenseBody };

/** The publisher key this build trusts (base64 SPKI DER), injected by the release build; empty = licences off. */
export const BUILT_IN_PUBKEY = process.env.CORTEX_LICENSE_PUBKEY_BUILTIN ?? "";
/** The licence server (workers/license), injected by the release build. */
export const LICENSE_SERVER =
  process.env.SAVANT_LICENSE_URL_BUILTIN || "https://savant-license.samplayz2ks.workers.dev";

/** Where people buy and manage Savant (the Whop store), injected by the release build. */
export const STORE_URL = process.env.SAVANT_STORE_URL_BUILTIN || "https://whop.com/savant-agent/";

export type LicenseState =
  | { required: false }
  | { required: true; ok: true; license: LicenseBody; daysLeft: number | null }
  | { required: true; ok: false; reason: string };

export function checkLicense(
  raw: unknown,
  pubkeyB64: string,
  now = Date.now(),
  machine?: string,
): LicenseState {
  if (!pubkeyB64) return { required: false };
  if (raw === null || raw === undefined)
    return { required: true, ok: false, reason: "No licence installed." };
  const p = LicenseSchema.safeParse(raw);
  if (!p.success) return { required: true, ok: false, reason: "The licence file is not valid." };
  const { sig, ...body } = p.data;
  let good = false;
  try {
    const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
    good = verify(null, Buffer.from(licenseBody(body as LicenseBody)), key, Buffer.from(sig, "base64"));
  } catch {
    good = false;
  }
  if (!good) return { required: true, ok: false, reason: "The licence signature doesn't match this app." };
  if (body.v === 2 && machine !== undefined && body.machine !== machine)
    return {
      required: true,
      ok: false,
      reason: "This licence was activated on another computer. Enter your licence key again to move it here.",
    };
  const exp = body.expires_at ? Date.parse(body.expires_at) : null;
  if (exp !== null && !(exp > now))
    return {
      required: true,
      ok: false,
      reason:
        body.v === 2
          ? "The licence couldn't be renewed for 14 days (offline, or the subscription ended). Connect to the internet, or check your Whop subscription."
          : `The licence expired on ${body.expires_at?.slice(0, 10)}.`,
    };
  return {
    required: true,
    ok: true,
    license: body as LicenseBody,
    daysLeft: exp === null ? null : Math.floor((exp - now) / 86_400_000),
  };
}

export const licensePath = (home: string) => join(home, "license.json");

export function readLicense(home: string, pubkey = BUILT_IN_PUBKEY, now = Date.now()): LicenseState {
  if (!pubkey) return { required: false };
  const p = licensePath(home);
  if (!existsSync(p)) return checkLicense(null, pubkey, now);
  try {
    return checkLicense(JSON.parse(readFileSync(p, "utf8")), pubkey, now, machineId(home));
  } catch {
    return { required: true, ok: false, reason: "The licence file can't be read." };
  }
}

export function installLicense(home: string, text: string, pubkey = BUILT_IN_PUBKEY): LicenseState {
  const raw = JSON.parse(text) as unknown;
  const st = checkLicense(raw, pubkey, Date.now(), machineId(home));
  if (st.required && !st.ok) throw new Error(st.reason);
  writeFileSync(licensePath(home), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return st;
}

/** True when trading must be held to exits only (paper/live without a valid licence on a licensed build). */
export const entriesBlocked = (st: LicenseState) => st.required && !st.ok;

// ------------------------------------------------------------------ Whop licence keys (ADR-086)

type Fetch = (u: string, i?: RequestInit) => Promise<Response>;

/** Exchange a Whop licence key for a machine-bound token. Saves it on success. */
/** A readable name for this computer, shown on the customer's account page (ADR-093). */
export function deviceName(): string {
  const n = hostname()
    .replace(/\.(local|lan|home)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .slice(0, 60);
  return n || "This computer";
}

/**
 * ADR-093: device sign-in. The app asks the server for a short code and a page to open; the user signs in on
 * getsavant.pro and approves; pollDeviceSignIn then returns the licence key, which activates through activateKey().
 */
export async function startDeviceSignIn(
  home: string,
  o: { server?: string; fetcher?: Fetch } = {},
): Promise<
  { ok: true; code: string; url: string; secret: string; expiresIn: number } | { ok: false; message: string }
> {
  const f = o.fetcher ?? ((u, i) => fetch(u, i));
  try {
    const res = await f(`${(o.server ?? LICENSE_SERVER).replace(/\/$/, "")}/v1/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine: machineId(home), name: deviceName() }),
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await res.json()) as {
      ok: boolean;
      message?: string;
      user_code?: string;
      verify_url?: string;
      device_secret?: string;
      expires_in?: number;
    };
    if (!d.ok || !d.user_code || !d.verify_url || !d.device_secret)
      return { ok: false, message: d.message ?? "Sign-in isn't available right now." };
    return {
      ok: true,
      code: d.user_code,
      url: d.verify_url,
      secret: d.device_secret,
      expiresIn: d.expires_in ?? 900,
    };
  } catch {
    return {
      ok: false,
      message: "Couldn't reach the licence server. Check the internet connection and try again.",
    };
  }
}

export async function pollDeviceSignIn(
  secret: string,
  o: { server?: string; fetcher?: Fetch } = {},
): Promise<{ status: "pending" | "approved" | "expired" | "error"; key?: string }> {
  const f = o.fetcher ?? ((u, i) => fetch(u, i));
  try {
    const res = await f(`${(o.server ?? LICENSE_SERVER).replace(/\/$/, "")}/v1/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_secret: secret }),
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await res.json()) as { status?: string; key?: string };
    if (d.status === "approved" && d.key) return { status: "approved", key: d.key };
    if (d.status === "pending" || d.status === "expired") return { status: d.status };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export async function activateKey(
  home: string,
  key: string,
  o: { server?: string; fetcher?: Fetch; pubkey?: string; app?: string } = {},
): Promise<{ ok: boolean; message: string; state?: LicenseState }> {
  const f = o.fetcher ?? ((u, i) => fetch(u, i));
  const machine = machineId(home);
  let r: ActivateResponse;
  try {
    const res = await f(`${(o.server ?? LICENSE_SERVER).replace(/\/$/, "")}/v1/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key.trim(), machine, app: o.app, name: deviceName() }),
      signal: AbortSignal.timeout(20_000),
    });
    r = (await res.json()) as ActivateResponse;
  } catch {
    return {
      ok: false,
      message: "Couldn't reach the licence server. Check the internet connection and try again.",
    };
  }
  if (!r.ok) return { ok: false, message: r.message };
  const pubkey = o.pubkey ?? BUILT_IN_PUBKEY;
  const st = checkLicense(r.license, pubkey, Date.now(), machine);
  if (st.required && !st.ok) return { ok: false, message: st.reason };
  writeFileSync(licensePath(home), `${JSON.stringify(r.license, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, message: r.message, state: st };
}

/** Free this machine's binding so the key can be activated on another computer. */
export async function releaseKey(
  home: string,
  key: string,
  o: { server?: string; fetcher?: Fetch } = {},
): Promise<{ ok: boolean; message: string }> {
  const f = o.fetcher ?? ((u, i) => fetch(u, i));
  try {
    const res = await f(`${(o.server ?? LICENSE_SERVER).replace(/\/$/, "")}/v1/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key.trim(), machine: machineId(home) }),
      signal: AbortSignal.timeout(20_000),
    });
    const r = (await res.json()) as { ok: boolean; message: string };
    if (r.ok) rmSync(licensePath(home), { force: true });
    return r;
  } catch {
    return { ok: false, message: "Couldn't reach the licence server. Try again when you're online." };
  }
}

/**
 * Daily refresh (the runtime calls this): a v2 token past its `refresh_after` is renewed with the stored key. A
 * network failure keeps the current token (it is valid for up to 14 days). A definite "no" from the server (refunded,
 * cancelled, moved to another computer) removes the token, which holds new entries.
 */
export async function refreshLicense(
  home: string,
  key: string | undefined,
  o: { server?: string; fetcher?: Fetch; pubkey?: string; now?: number } = {},
): Promise<"fresh" | "renewed" | "offline" | "revoked" | "none"> {
  if (!key) return "none";
  const p = licensePath(home);
  let cur: License | null = null;
  try {
    cur = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as License) : null;
  } catch {
    cur = null;
  }
  const now = o.now ?? Date.now();
  if (cur?.v === 2 && Date.parse(cur.refresh_after) > now) return "fresh";
  if (cur?.v === 1) return "fresh"; // publisher-issued files don't refresh
  const f = o.fetcher ?? ((u, i) => fetch(u, i));
  let r: ActivateResponse;
  try {
    const res = await f(`${(o.server ?? LICENSE_SERVER).replace(/\/$/, "")}/v1/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key.trim(), machine: machineId(home) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 500) return "offline";
    r = (await res.json()) as ActivateResponse;
  } catch {
    return "offline";
  }
  if (!r.ok) {
    if (
      [
        "membership_inactive",
        "unknown_key",
        "bound_to_another_machine",
        "wrong_product",
        "free_plan",
      ].includes(r.code)
    )
      rmSync(p, { force: true });
    return r.code === "rate_limited" ? "offline" : "revoked";
  }
  const st = checkLicense(r.license, o.pubkey ?? BUILT_IN_PUBKEY, now, machineId(home));
  if (st.required && !st.ok) return "offline";
  writeFileSync(p, `${JSON.stringify(r.license, null, 2)}\n`, { mode: 0o600 });
  return "renewed";
}

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
  const body: LicenseBody = {
    kind: LICENSE_KIND,
    v: 1,
    id: o.id,
    licensee: o.licensee,
    plan: o.plan,
    issued_at: now.toISOString(),
    expires_at: o.days === null ? null : new Date(now.getTime() + o.days * 86_400_000).toISOString(),
  };
  const sig = sign(null, Buffer.from(licenseBody(body)), createPrivateKey(privateKeyPem)).toString("base64");
  return { ...body, sig } as License;
}
