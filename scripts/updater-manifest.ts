/**
 * Compose the Tauri updater manifest (latest.json) from each platform's `updater-<platform>.json` (ADR-077). The app
 * reads it from getsavant.pro/updates/latest.json (the latest release) and installs only bundles whose signature matches the key built into it.
 *
 *   node scripts/updater-manifest.ts <dir> <version> <notes.md> > latest.json
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, notesFile] = process.argv.slice(2);
if (!dir || !version) throw new Error("usage: <dir> <version> [notes.md]");
// Bundles are linked through the product domain (vercel.json redirects /download/* to the release files), so moving
// where releases are hosted only changes the redirect, never an installed app.
const base = (process.env.SAVANT_DOWNLOAD_BASE ?? "https://getsavant.pro").replace(/\/$/, "");
const platforms: Record<string, { signature: string; url: string }> = {};
for (const f of readdirSync(dir).filter((x) => /^updater-.+\.json$/.test(x))) {
  const u = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
    platform: string;
    name: string;
    signature: string;
  };
  platforms[u.platform] = {
    signature: u.signature,
    url: `${base}/download/v${version}/${u.name}`,
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
