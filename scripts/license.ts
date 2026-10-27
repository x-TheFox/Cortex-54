/**
 * Publisher tool for licences (ADR-077). Never run by customers; the private key never leaves the publisher's machine.
 *
 *   tsx scripts/license.ts keygen [--out ~/.cortex-publisher/license.key]   prints the public key for CORTEX_LICENSE_PUBKEY
 *   tsx scripts/license.ts issue --key FILE --licensee "Name" [--plan pro] [--days 365|forever] [--id ID]
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { issueLicense, publisherKeygen } from "../local/license.ts";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "keygen") {
  const out = opt("out") ?? join(homedir(), ".cortex-publisher", "license.key");
  if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a publisher key`);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const k = publisherKeygen();
  writeFileSync(out, k.privateKeyPem, { mode: 0o600 });
  console.log(`Private key: ${out} (back it up offline; never commit it)`);
  console.log(`Public key (set as the CORTEX_LICENSE_PUBKEY repository variable):\n${k.publicKeyB64}`);
} else if (args[0] === "issue") {
  const key = opt("key");
  const licensee = opt("licensee");
  if (!key || !licensee) throw new Error("issue --key FILE --licensee NAME [--plan P] [--days N|forever]");
  const days = opt("days") === "forever" ? null : Number(opt("days") ?? 365);
  const lic = issueLicense(readFileSync(key, "utf8"), {
    id: opt("id") ?? randomUUID(),
    licensee,
    plan: opt("plan") ?? "standard",
    days,
  });
  console.log(JSON.stringify(lic, null, 2));
} else
  console.log(
    "tsx scripts/license.ts keygen | issue --key FILE --licensee NAME [--plan P] [--days N|forever]",
  );
