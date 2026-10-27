import { z } from "zod";
import { rowHash } from "../journal/Journal.ts";
import { sha256Hex } from "../lib/sha256.ts";

/**
 * Savant community hub protocol (ADR-068). The hub is the one service the publisher runs; it never sees broker keys
 * and never trades. Agents identify by an Ed25519 key they generate themselves (agent id = first 16 hex of
 * sha256(public key)). Everything an agent sends is signed; every journal row it publishes carries its own hash and
 * its predecessor's, so the hub (and anyone reading the feed) can recompute the hash chain link by link. A
 * published track record can't be edited after the fact without breaking signatures and hashes.
 */

/** Stable JSON: object keys sorted at every depth (what gets signed). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

const b64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function generateAgentKey(): Promise<{
  privateKey: string;
  publicKey: string;
  agentId: string;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = b64((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const pub = b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { privateKey: priv, publicKey: pub, agentId: agentIdOf(pub) };
}

export const agentIdOf = (publicKey: string) => sha256Hex(`cortex-agent:${publicKey}`).slice(0, 16);

/** Public key (raw, base64) of a pkcs8 Ed25519 private key. */
export async function publicKeyOf(privateKey: string): Promise<string> {
  const k = await crypto.subtle.importKey("pkcs8", unb64(privateKey), { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", k)) as JsonWebKey;
  const x = (jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return x + "=".repeat((4 - (x.length % 4)) % 4);
}

export async function signPayload(privateKey: string, payload: unknown): Promise<string> {
  const k = await crypto.subtle.importKey("pkcs8", unb64(privateKey), { name: "Ed25519" }, false, ["sign"]);
  return b64(await crypto.subtle.sign({ name: "Ed25519" }, k, new TextEncoder().encode(canonical(payload))));
}

export async function verifyPayload(publicKey: string, payload: unknown, sig: string): Promise<boolean> {
  try {
    const k = await crypto.subtle.importKey("raw", unb64(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      k,
      unb64(sig),
      new TextEncoder().encode(canonical(payload)),
    );
  } catch {
    return false;
  }
}

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const FeedRowSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.number().int(),
  account: z.string().max(10),
  kind: z.string().max(40),
  ref_id: z.string().max(80).nullable(),
  payload_json: z.string().max(8000),
  prev_row_sha256: Hex64,
  row_sha256: Hex64,
});
export type FeedRow = z.infer<typeof FeedRowSchema>;

/** Each published row must hash to what it claims, from the predecessor it claims. */
export const rowIsConsistent = (r: FeedRow) =>
  rowHash(r.prev_row_sha256, r.seq, r.ts, r.kind, r.payload_json) === r.row_sha256;

export const FeedBatchSchema = z.object({
  v: z.literal(1),
  public_key: z.string().min(40).max(60),
  name: z.string().max(40).optional(),
  sent_at: z.number().int(),
  head: z.object({ seq: z.number().int().nonnegative(), sha: Hex64 }),
  rows: z.array(FeedRowSchema).max(200),
  sig: z.string().min(40),
});
export type FeedBatch = z.infer<typeof FeedBatchSchema>;

export const PackSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["memory", "strategy-params"]),
  title: z.string().min(3).max(80),
  description: z.string().max(600).default(""),
  public_key: z.string().min(40).max(60),
  created_at: z.number().int(),
  /** memory: { scar_rules: [...], beliefs: [...] }; strategy-params: { strategy_id, params } */
  content: z.record(z.string(), z.unknown()),
  sig: z.string().min(40),
});
export type Pack = z.infer<typeof PackSchema>;

export const unsigned = <T extends { sig: string }>(x: T): Omit<T, "sig"> => {
  const { sig: _s, ...rest } = x;
  return rest;
};

/** Journal kinds an agent publishes: what it decided and how it turned out. Never keys, never account ids. */
export const PUBLIC_KINDS = new Set([
  "CONTRACT",
  "COURT",
  "EXIT",
  "EXCURSIONS",
  "REVIEW",
  "ROTATE",
  "DAY_ROLL",
]);
