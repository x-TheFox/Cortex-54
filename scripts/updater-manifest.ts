/**
 * Compose the Tauri updater manifest (latest.json) from each platform's `updater-<platform>.json` (ADR-077). The app
 * reads it from the latest GitHub release and installs only bundles whose signature matches the key built into it.
 *
 *   node scripts/updater-manifest.ts <dir> <version> <notes.md> > latest.json
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, notesFile] = process.argv.slice(2);
if (!dir || !version) throw new Error("usage: <dir> <version> [notes.md]");
const repo = process.env.GITHUB_REPOSITORY ?? "x-TheFox/Cortex-54";
const platforms: Record<string, { signature: string; url: string }> = {};
for (const f of readdirSync(dir).filter((x) => /^updater-.+\.json$/.test(x))) {
  const u = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
    platform: string;
    name: string;
    signature: string;
  };
  platforms[u.platform] = {
    signature: u.signature,
    url: `https://github.com/${repo}/releases/download/v${version}/${u.name}`,
  };
}
if (!Object.keys(platforms).length)
  throw new Error("no signed updater bundles (is TAURI_SIGNING_PRIVATE_KEY set?)");
console.log(
  JSON.stringify(
    {
      version,
      notes: notesFile ? readFileSync(notesFile, "utf8").slice(0, 4000) : "",
      pub_date: new Date().toISOString(),
      platforms,
    },
    null,
    2,
  ),
);
