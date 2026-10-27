/**
 * HMAC-SHA256 request signing for the signed routes (/ingest/batch, /governor/export, /runner/claim, /admin/reset).
 * Signature = hex(HMAC(secret, `${timestamp}.${route}.${body}`)) with `x-cortex-audience: <route>` (audit F-A3-03: a
 * signature is bound to one route, so a captured ingest request can't be replayed to another endpoint). The legacy
 * form, hex(HMAC(secret, `${timestamp}.${body}`)) without the audience header, is accepted only where a route opts in
 * (ingest, for runs of an older research checkout). Sent as `x-cortex-signature: sha256=<hex>` with
 * `x-cortex-timestamp: <unix seconds>`. Timestamps outside ±10 minutes are rejected (replay window).
 */
const enc = new TextEncoder();

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignedBody(
  secret: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  body: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=") || !timestampHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > 600) return false;
  const expected = await hmacHex(secret, `${timestampHeader}.${body}`);
  return timingSafeEqual(signatureHeader.slice("sha256=".length), expected);
}

/** Headers for a signed POST to `route` (the path, e.g. "/runner/claim"). */
export async function signedHeaders(secret: string, route: string, body: string, nowMs = Date.now()) {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    "content-type": "application/json",
    "x-cortex-timestamp": ts,
    "x-cortex-audience": route,
    "x-cortex-signature": `sha256=${await hmacHex(secret, `${ts}.${route}.${body}`)}`,
  };
}

/** Verify a signed request for `route` (audit F-A3-03). */
export async function verifyRoute(
  secret: string,
  headers: { get(name: string): string | null },
  route: string,
  body: string,
  opts: { legacyOk?: boolean; nowMs?: number } = {},
): Promise<boolean> {
  const aud = headers.get("x-cortex-audience");
  const sig = headers.get("x-cortex-signature");
  const ts = headers.get("x-cortex-timestamp");
  if (aud === null) return opts.legacyOk === true && verifySignedBody(secret, sig, ts, body, opts.nowMs);
  if (aud !== route) return false;
  return verifySignedBody(secret, sig, ts, `${route}.${body}`, opts.nowMs);
}
