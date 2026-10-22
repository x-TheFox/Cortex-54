/**
 * HMAC-SHA256 request signing for /ingest/batch.
 * Signature = hex(HMAC(secret, `${timestamp}.${body}`)), sent as `x-cortex-signature: sha256=<hex>` with
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
