/**
 * Release planning for the desktop app (ADR-077): the next version and its changelog, from git alone.
 *
 *   node scripts/changelog.ts [--bump patch|minor|major] [--out notes.md]
 *     → prints {"version":"0.1.3","tag":"v0.1.3","previous":"v0.1.2"} and writes the release notes
 *
 * The version is the latest `vX.Y.Z` tag bumped (the first release uses the version in tauri.conf.json). Notes list the
 * commits since that tag, grouped by what they did; squash-merged PRs make one line each. Runs on plain Node (type
 * stripping), so CI needs no install step for it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();

type Semver = [number, number, number];
const parse = (v: string): Semver | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const fmt = (v: Semver) => v.join(".");

export function nextVersion(previous: string | null, base: string, bump: string): string {
  const p = previous ? parse(previous) : null;
  if (!p) return fmt(parse(base) ?? [0, 1, 0]);
  if (bump === "major") return fmt([p[0] + 1, 0, 0]);
  if (bump === "minor") return fmt([p[0], p[1] + 1, 0]);
  return fmt([p[0], p[1], p[2] + 1]);
}

export function group(subjects: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = { New: [], Fixes: [], Safety: [], Docs: [], Changes: [] };
  for (const s of subjects) {
    if (/^release v\d/i.test(s)) continue;
    const k = /^(fix|fixes|fixed|bug)\b|\b(fix(es)?|bug|broken|false alarm|self-heal|regression)\b/i.test(s)
      ? "Fixes"
      : /\b(safety|risk|kill|breaker|stop|fail closed|guard)\b/i.test(s)
        ? "Safety"
        : /^(docs?|readme|adr)\b/i.test(s)
          ? "Docs"
          : /^(add|adds|added|new|build|implement|feat|introduce|support|phase \d)\b/i.test(s)
            ? "New"
            : "Changes";
    (out[k] as string[]).push(s);
  }
  return out;
}

if (process.argv[1]?.endsWith("changelog.ts")) {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname")
    .split("\n")
    .filter((t) => parse(t));
  const previous = tags[0] ?? null;
  const base = JSON.parse(readFileSync("desktop/src-tauri/tauri.conf.json", "utf8")).version as string;
  const version = nextVersion(previous, base, opt("bump") ?? "patch");
  const range = previous ? `${previous}..HEAD` : "HEAD";
  const subjects = git("log", "--no-merges", "--format=%s", range).split("\n").filter(Boolean);
  // the first release would list the whole history: keep it to the latest 40
  const g = group(subjects.slice(0, previous ? 200 : 40));
  const repo = process.env.GITHUB_REPOSITORY ?? "x-TheFox/Cortex-54";
  const sections = Object.entries(g)
    .filter(([, l]) => l.length)
    .map(([k, l]) => `### ${k}\n${l.map((s) => `- ${s}`).join("\n")}`)
    .join("\n\n");
  const notes = [
    `## CORTEX-54 ${version}`,
    "",
    sections || "Maintenance build.",
    "",
    "### Install",
    "- **macOS** (Apple silicon or Intel): open the `.dmg` and drag CORTEX-54 to Applications. The app isn't notarized yet: the first time, right-click it and choose Open.",
    "- **Windows**: run the `-setup.exe` (or the `.msi`). SmartScreen may ask once: More info → Run anyway.",
    "- **Linux**: the `.AppImage` (make it executable), or the `.deb` / `.rpm`.",
    "",
    "Installed apps update themselves from here: the tray menu offers each new version (signed, checked before install).",
    "",
    previous
      ? `Full list of changes: https://github.com/${repo}/compare/${previous}...v${version}`
      : "First release.",
  ].join("\n");
  writeFileSync(opt("out") ?? "release-notes.md", `${notes}\n`);
  console.log(JSON.stringify({ version, tag: `v${version}`, previous }));
}
