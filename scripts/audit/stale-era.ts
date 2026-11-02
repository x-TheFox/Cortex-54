/**
 * Stale-era finder (pre-release audit addendum; docs/audit/HARNESS.md §stale-era).
 *
 *   pnpm exec tsx scripts/audit/stale-era.ts [--json out.json] [--bundle path/to/Savant.app] [--live http://127.0.0.1:8754]
 *
 * CORTEX-54 started as one operator's own cloud deployment (Discord-first, GitHub Actions, Workers, a $54 account,
 * "the operator"). Savant is now a product customers run themselves. This scan lists every leftover a CUSTOMER can see
 * or hit, so each can be reworded or removed. It reads:
 *   1. source of customer-facing surfaces (web/, landing/, local/, desktop/, the cards and messages in src/),
 *   2. optionally a shipped bundle (strings in the web build, manifest, Info.plist, executable name),
 *   3. optionally a running app's unauthenticated HTTP answers.
 * Exit code 1 when a "high" finding exists, so it can gate CI once the backlog is cleared.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

interface Rule {
  id: string;
  severity: "high" | "medium" | "low";
  what: string;
  re: RegExp;
  /** a better word for it, if obvious */
  fix: string;
}

const RULES: Rule[] = [
  {
    id: "brand-cortex54",
    severity: "high",
    what: "old product name",
    re: /CORTEX[-_ ]?54|cortex54|cortex-54/i,
    fix: "Savant (app) / Cortex (agent)",
  },
  {
    id: "discord-terminal",
    severity: "high",
    what: "tells the user to sign in through Discord /terminal",
    re: /\/terminal in Discord|sign in with \/terminal/i,
    fix: "open the Savant app (or the sign-in link it shows)",
  },
  {
    id: "operator-host",
    severity: "high",
    what: "the operator's own worker host or ids",
    re: /samplayz2ks|x-TheFox/,
    fix: "product domain (getsavant.pro) or config",
  },
  {
    id: "github-actions",
    severity: "medium",
    what: "GitHub Actions / PR / workflow wording a customer can't act on",
    re: /\bgh workflow\b|GitHub Actions|pull request|\bopens? a PR\b|merge (the|a) PR|research\.yml|governor\.yml|kill-switch\.yml/i,
    fix: "describe what the app does on the user's computer",
  },
  {
    id: "operator-word",
    severity: "medium",
    what: "'operator' in customer-facing text",
    re: /\boperator\b/i,
    fix: "you",
  },
  {
    id: "dollar-54",
    severity: "medium",
    what: "the $54 reference account presented as the user's account",
    re: /\$54\b|starting with \$54|simulated \$54/,
    fix: "the user's own balance (or 'a small account')",
  },
  {
    id: "thirty-day-clock",
    severity: "low",
    what: "operator graduation jargon",
    re: /30-day (autonomous )?clock|autonomous clock|graduation gate|postmortem/i,
    fix: "plain words: 'paper record', 'review'",
  },
  {
    id: "cloud-budget",
    severity: "low",
    what: "Cloudflare free-tier wording in local mode",
    re: /Workers Free|free[- ]tier budget|neurons\b|\bD1\b|Durable Object|wrangler/i,
    fix: "hide in local mode or say 'AI allowance'",
  },
  {
    id: "adr-ref",
    severity: "low",
    what: "internal ADR / RUNBOOK references in UI text",
    re: /\bADR-\d{3}\b|RUNBOOK|docs\/[A-Z_]+\.md/,
    fix: "remove from UI strings",
  },
  {
    id: "stop-dial",
    severity: "low",
    what: "dial jargon (Stop 0/2/3/4) without explanation",
    re: /\bStop [0-4]\b|STOP [0-4]\b/,
    fix: "Off / Paper / Live",
  },
];

/** Customer-facing source roots. Comments are skipped; strings and JSX text are what customers read. */
const ROOTS = [
  "web/src",
  "landing",
  "local",
  "desktop/src-tauri/src",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/Cargo.toml",
  "src/cortex/cards.ts",
  "src/web",
  "src/notify",
  "src/discord",
  "docs/legal",
];
const SKIP =
  /node_modules|\.test\.|\/dist\/|landing-dist|demo-dist|\/target\/|CLAUDE\.md|\.css$|\.webp$|\.png$|\.svg$|\.woff/;

interface Hit {
  rule: string;
  severity: Rule["severity"];
  where: string;
  line: number;
  text: string;
  surface: "source" | "bundle" | "live";
}

function* files(p: string): Generator<string> {
  if (!existsSync(p)) return;
  if (statSync(p).isFile()) {
    yield p;
    return;
  }
  for (const f of readdirSync(p)) {
    const q = join(p, f);
    if (SKIP.test(q)) continue;
    if (statSync(q).isDirectory()) yield* files(q);
    else if (/\.(ts|tsx|html|md|json|toml|rs|yaml)$/.test(q)) yield q;
  }
}

/** True when the line is (most likely) a comment, not text shown to a customer. */
function isComment(line: string, inBlock: boolean): boolean {
  const t = line.trim();
  return (
    inBlock ||
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("#") ||
    t.startsWith("<!--")
  );
}

function scanText(text: string, where: string, surface: Hit["surface"], skipComments: boolean): Hit[] {
  const hits: Hit[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    const opens = line.includes("/*") && !line.includes("*/");
    const comment = skipComments && isComment(line, inBlock);
    if (opens) inBlock = true;
    if (line.includes("*/")) inBlock = false;
    if (comment) return;
    // only quoted strings, template text or markup carry customer copy
    if (skipComments && !/["'`>]/.test(line)) return;
    // deliberate backward compatibility (old data folder, old backup magic, pre-rebrand Discord servers): keep, low
    const compat =
      /legacy|pre-rebrand|MAGIC|"cortex-54-backup"|\.cortex54"\)|base\.join\("\.cortex54"\)/i.test(line);
    for (const r of RULES)
      if (r.re.test(line))
        hits.push({
          rule: compat ? `${r.id} (compat)` : r.id,
          severity: compat ? "low" : r.severity,
          where,
          line: i + 1,
          text: line.trim().slice(0, 160),
          surface,
        });
  });
  return hits;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hits: Hit[] = [];
  for (const root of ROOTS)
    for (const f of files(root))
      hits.push(...scanText(readFileSync(f, "utf8"), relative(".", f), "source", true));

  const bundle = opt("bundle");
  if (bundle) {
    const res = join(bundle, "Contents", "Resources", "cortexd");
    for (const f of files(join(res, "public"))) {
      if (!/\.(html|json|webmanifest|js)$/.test(f)) continue;
      // minified JS: scan string literals only
      const txt = readFileSync(f, "utf8");
      const strings = f.endsWith(".js")
        ? (txt.match(/"[^"\n]{8,300}"|`[^`]{8,300}`/g) ?? []).join("\n")
        : txt;
      hits.push(...scanText(strings, relative(bundle, f), "bundle", false));
    }
    const plist = join(bundle, "Contents", "Info.plist");
    if (existsSync(plist)) hits.push(...scanText(readFileSync(plist, "utf8"), "Info.plist", "bundle", false));
    const mf = join(res, "public", "manifest.webmanifest");
    if (existsSync(mf))
      hits.push(...scanText(readFileSync(mf, "utf8"), "manifest.webmanifest", "bundle", false));
  }

  const live = opt("live");
  if (live)
    for (const p of [
      "/health",
      "/api/status",
      "/api/feed",
      "/api/settings",
      "/pill",
      "/manifest.webmanifest",
      "/nope",
    ]) {
      try {
        const r = await fetch(`${live}${p}`);
        hits.push(...scanText(await r.text(), `GET ${p} (${r.status})`, "live", false));
      } catch {
        /* app not running */
      }
    }

  // de-duplicate identical (rule, where, line)
  const seen = new Set<string>();
  const out = hits.filter((h) => {
    const k = `${h.rule}|${h.where}|${h.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const by: Record<string, number> = {};
  for (const h of out) by[`${h.severity} ${h.rule}`] = (by[`${h.severity} ${h.rule}`] ?? 0) + 1;
  console.log(JSON.stringify(by, null, 2));
  for (const h of out.filter((x) => x.severity !== "low").slice(0, 90))
    console.log(
      `${h.severity.padEnd(6)} ${h.rule.padEnd(18)} ${h.surface.padEnd(6)} ${h.where}:${h.line}  ${h.text}`,
    );
  const file = opt("json");
  if (file)
    writeFileSync(
      file,
      JSON.stringify({ rules: RULES.map((r) => ({ ...r, re: String(r.re) })), hits: out }, null, 2),
    );
  process.exitCode = out.some((h) => h.severity === "high") ? 1 : 0;
}

await main();
