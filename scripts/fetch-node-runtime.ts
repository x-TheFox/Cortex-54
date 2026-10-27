/**
 * Fetch the official standalone Node.js runtime for the desktop app's sidecar (ADR-066), verified against the
 * SHASUMS256.txt Node publishes for that release. Homebrew/nvm `node` binaries link to shared libraries and can't be
 * shipped. Usage: tsx scripts/fetch-node-runtime.ts [target-triple] (default: this machine).
 * Audit F-A6-04: the version and every archive's sha256 are pinned here, so the download channel is no longer the trust
 * root for what lands inside the signed installers. To move to a newer Node, update NODE_VERSION and the hashes from
 * https://nodejs.org/dist/<version>/SHASUMS256.txt in a reviewed commit.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Node 24 LTS (node:sqlite needs ≥ 22.13; `cortex doctor` checks the same floor). Released 2026-10-20. */
export const NODE_VERSION = "v24.22.1";
const TRIPLES: Record<string, { dist: string; ext: "tar.gz" | "zip"; bin: string; sha256: string }> = {
  "aarch64-apple-darwin": {
    dist: "darwin-arm64",
    ext: "tar.gz",
    bin: "bin/node",
    sha256: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  },
  "x86_64-apple-darwin": {
    dist: "darwin-x64",
    ext: "tar.gz",
    bin: "bin/node",
    sha256: "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
  },
  "x86_64-unknown-linux-gnu": {
    dist: "linux-x64",
    ext: "tar.gz",
    bin: "bin/node",
    sha256: "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
  },
  "aarch64-unknown-linux-gnu": {
    dist: "linux-arm64",
    ext: "tar.gz",
    bin: "bin/node",
    sha256: "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
  },
  "x86_64-pc-windows-msvc": {
    dist: "win-x64",
    ext: "zip",
    bin: "node.exe",
    sha256: "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
  },
};
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1] ?? "";
const triple = process.argv[2] ?? host;
const t = TRIPLES[triple];
if (!t) throw new Error(`unsupported target ${triple}`);

const version = NODE_VERSION;
const name = `node-${version}-${t.dist}`;
const file = `${name}.${t.ext}`;
const base = `https://nodejs.org/dist/${version}`;
const want = t.sha256;
const buf = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer());
const got = createHash("sha256").update(buf).digest("hex");
if (got !== want) throw new Error(`checksum mismatch for ${file}`);
const dir = mkdtempSync(join(tmpdir(), "node-rt-"));
const archive = join(dir, file);
writeFileSync(archive, buf);
execFileSync("tar", ["-xf", archive, "-C", dir]); // bsdtar reads .zip too (macOS, Windows 10+)
const outDir = "desktop/src-tauri/binaries";
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `node-${triple}${t.ext === "zip" ? ".exe" : ""}`);
copyFileSync(join(dir, name, t.bin), dest);
chmodSync(dest, 0o755);
console.log(`${version} ${t.dist} (sha256 ${got.slice(0, 12)}…) → ${dest}`);
