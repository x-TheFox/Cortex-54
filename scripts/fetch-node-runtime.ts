/**
 * Fetch the official standalone Node.js runtime for the desktop app's sidecar (ADR-066), verified against the
 * SHASUMS256.txt Node publishes for that release. Homebrew/nvm `node` binaries link to shared libraries and can't be
 * shipped. Usage: tsx scripts/fetch-node-runtime.ts [target-triple] (default: this machine).
 * Picks the newest release of the Node LTS line we test on (node:sqlite needs ≥ 22.13).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LTS_MAJOR = 24;
const TRIPLES: Record<string, { dist: string; ext: "tar.gz" | "zip"; bin: string }> = {
  "aarch64-apple-darwin": { dist: "darwin-arm64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-apple-darwin": { dist: "darwin-x64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-unknown-linux-gnu": { dist: "linux-x64", ext: "tar.gz", bin: "bin/node" },
  "aarch64-unknown-linux-gnu": { dist: "linux-arm64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-pc-windows-msvc": { dist: "win-x64", ext: "zip", bin: "node.exe" },
};
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1] ?? "";
const triple = process.argv[2] ?? host;
const t = TRIPLES[triple];
if (!t) throw new Error(`unsupported target ${triple}`);

const index = (await (await fetch("https://nodejs.org/dist/index.json")).json()) as { version: string; lts: string | false }[];
const version = index.find((r) => r.lts && r.version.startsWith(`v${LTS_MAJOR}.`))?.version;
if (!version) throw new Error(`no Node ${LTS_MAJOR} LTS release found`);
const name = `node-${version}-${t.dist}`;
const file = `${name}.${t.ext}`;
const base = `https://nodejs.org/dist/${version}`;
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const want = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
if (!want) throw new Error(`${file} not in SHASUMS256.txt`);
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
