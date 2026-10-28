/**
 * Legal pages (ADR-087): docs/legal/*.md → standalone HTML pages, written into each output directory given.
 *   - landing-dist/legal/  (the website's /legal/terms.html …, linked from the footer and checkout)
 *   - public/legal/        (the app's own copy, opened from SETTINGS and the first-launch screen; works offline)
 *   - dist/cortexd/legal/  (shipped inside every installer, with LICENSE and THIRD_PARTY_NOTICES)
 *
 *   tsx scripts/build-legal.ts <outDir> [<outDir> …]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

export const LEGAL_DOCS = ["terms", "eula", "privacy", "refunds", "risk"] as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function page(md: string): { html: string; title: string; version: string } {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  const meta = Object.fromEntries(
    (fm?.[1] ?? "").split("\n").map((l) => l.split(/:\s*/, 2).map((x) => x.trim()) as [string, string]),
  );
  const body = marked.parse(md.slice(fm?.[0].length ?? 0), { async: false }) as string;
  const title = meta.title ?? "Savant";
  return {
    title,
    version: meta.version ?? "1",
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --ink:#15130f; --paper:#efebe3; --rule:#d8d1c3; --dim:#5e574b; }
@media (prefers-color-scheme: dark) { :root { --ink:#e9e4d8; --paper:#15130f; --rule:#3a352c; --dim:#a39b8b; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.6 ui-serif, Georgia, "Times New Roman", serif; }
main { max-width: 44rem; margin: 0 auto; padding: 48px 20px 96px; }
h1 { font-size: 2rem; line-height:1.2; margin: 0 0 .5rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; }
p, li { max-width: 70ch; }
a { color: inherit; }
nav { font: 13px/1.4 ui-monospace, Menlo, monospace; letter-spacing:.04em; color:var(--dim); border-bottom:1px solid var(--rule); padding-bottom:12px; margin-bottom:28px; display:flex; flex-wrap:wrap; gap:14px; }
nav a { text-decoration:none; } nav a:hover { text-decoration:underline; }
footer { margin-top:3rem; color:var(--dim); font-size:.9rem; }
</style>
</head>
<body>
<main>
<nav aria-label="Legal"><b>SAVANT</b>${LEGAL_DOCS.map((d) => `<a href="${d}.html">${d === "eula" ? "EULA" : d === "risk" ? "Risk" : d[0]?.toUpperCase() + d.slice(1)}</a>`).join("")}</nav>
${body}
<footer>Savant · ${esc(title)} · version ${esc(meta.version ?? "1")}${meta.effective ? ` · effective ${esc(meta.effective)}` : ""}</footer>
</main>
</body>
</html>
`,
  };
}

export function buildLegal(outDirs: string[]): void {
  for (const out of outDirs) {
    mkdirSync(out, { recursive: true });
    for (const d of LEGAL_DOCS) {
      const md = readFileSync(join("docs", "legal", `${d}.md`), "utf8");
      writeFileSync(join(out, `${d}.html`), page(md).html);
    }
    writeFileSync(
      join(out, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=terms.html"><a href="terms.html">Terms</a>`,
    );
  }
}

if (process.argv[1]?.endsWith("build-legal.ts")) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) throw new Error("usage: tsx scripts/build-legal.ts <outDir> [...]");
  buildLegal(dirs);
  // the installer copy also carries the plain texts, the licence and the third-party notices
  for (const out of dirs.filter((d) => d.includes("cortexd"))) {
    for (const f of readdirSync(join("docs", "legal"))) copyFileSync(join("docs", "legal", f), join(out, f));
    if (existsSync("LICENSE")) copyFileSync("LICENSE", join(out, "LICENSE.txt"));
  }
  console.log(`legal pages → ${dirs.join(", ")}`);
}
