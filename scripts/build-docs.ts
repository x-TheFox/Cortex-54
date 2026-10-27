/**
 * getsavant.pro/docs (ADR-093): the install guide and help pages, written in landing/docs/*.md and rendered at build
 * time into landing-dist/docs/<page>/index.html. Plain pages on the site's paper-and-ink palette; no scripts.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

const ORDER = [
  "index",
  "install",
  "getting-started",
  "account",
  "live-trading",
  "troubleshooting",
  "uninstall",
];
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function render(md: string): { title: string; body: string } {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  const title = /title:\s*(.+)/.exec(fm?.[1] ?? "")?.[1]?.trim() ?? "Savant docs";
  const m = new Marked({
    renderer: {
      heading({ tokens, depth, text }) {
        // "## Heading {#id}" sets the anchor; otherwise it comes from the words
        const custom = /\s*\{#([a-z0-9-]+)\}\s*$/.exec(text);
        const clean = custom ? text.slice(0, custom.index) : text;
        const inner = this.parser.parseInline(custom ? m.Lexer.lexInline(clean) : tokens);
        const id = custom?.[1] ?? slug(clean);
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
    },
  });
  return { title, body: m.parse(md.slice(fm?.[0].length ?? 0), { async: false }) as string };
}

function shell(title: string, body: string, current: string, titles: Record<string, string>): string {
  const nav = ORDER.filter((p) => titles[p])
    .map((p) => {
      const href = p === "index" ? "/docs/" : `/docs/${p}/`;
      const label = p === "index" ? "Overview" : (titles[p] ?? p);
      return `<a href="${href}"${p === current ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'" />
<title>${esc(title)} · Savant</title>
<meta name="description" content="${esc(title)}: help for Savant, the autonomous trading agent you run on your own computer." />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>
:root { color-scheme: light dark; --ink:#15130f; --paper:#efebe3; --paper2:#e7e2d6; --rule:#d3cbbb; --dim:#5e574b; }
@media (prefers-color-scheme: dark) { :root { --ink:#e9e4d8; --paper:#15130f; --paper2:#1d1a15; --rule:#3a352c; --dim:#a39b8b; } }
* { box-sizing: border-box; }
html { scroll-padding-top: 24px; }
body { margin:0; background:var(--paper); color:var(--ink); font:17px/1.6 ui-serif, Georgia, "Times New Roman", serif; }
.wrap { max-width: 68rem; margin: 0 auto; padding: 28px 16px 96px; display:grid; grid-template-columns: 14rem 1fr; gap: 48px; }
header { max-width: 68rem; margin: 0 auto; padding: 22px 16px 0; display:flex; justify-content:space-between; align-items:baseline; gap:16px; flex-wrap:wrap; }
header a { color:inherit; text-decoration:none; } .brand { font-size: 1.4rem; letter-spacing:-.01em; }
.top { font: 14px/1 ui-sans-serif, system-ui, sans-serif; display:flex; gap:18px; flex-wrap:wrap; }
.top a:hover { text-decoration: underline; }
nav.side { font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; display:flex; flex-direction:column; gap:2px; position: sticky; top: 20px; align-self:start; }
nav.side a { color:var(--dim); text-decoration:none; padding:7px 10px; border-radius:8px; }
nav.side a:hover { color:var(--ink); background:var(--paper2); }
nav.side a[aria-current] { color:var(--ink); background:var(--paper2); font-weight:600; }
main { min-width:0; max-width: 46rem; }
h1 { font-weight: 400; font-size: clamp(2rem, 4vw, 2.8rem); line-height:1.1; letter-spacing:-.02em; margin: 0 0 1rem; }
h2 { font-weight: 500; font-size: 1.35rem; margin: 2.4rem 0 .6rem; padding-top: .6rem; border-top: 1px solid var(--rule); }
h3 { font-size: 1.05rem; margin: 1.6rem 0 .4rem; }
p, li { max-width: 68ch; } a { color: inherit; }
code { font: .86em/1.4 ui-monospace, Menlo, Consolas, monospace; background: var(--paper2); padding: .1em .35em; border-radius: 5px; }
pre { background: var(--paper2); border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 1rem 0; display:block; overflow-x:auto; }
th, td { text-align:left; padding: 9px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
blockquote { margin: 1.4rem 0; padding: 12px 16px; border-left: 3px solid var(--ink); background: var(--paper2); border-radius: 0 10px 10px 0; }
blockquote p { margin: 0; }
footer { margin-top:3rem; color:var(--dim); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
@media (max-width: 800px) { .wrap { grid-template-columns: 1fr; gap: 20px; } nav.side { position: static; flex-direction:row; flex-wrap:wrap; } }
</style>
</head>
<body>
<header>
<a class="brand" href="/">Savant</a>
<nav class="top" aria-label="Site"><a href="/docs/">Docs</a><a href="/#pricing">Pricing</a><a href="/account/">Your account</a></nav>
</header>
<div class="wrap">
<nav class="side" aria-label="Docs">${nav}</nav>
<main>
${body}
<footer>Savant docs · <a href="/legal/terms.html">Terms</a> · <a href="/legal/privacy.html">Privacy</a> · <a href="/legal/risk.html">Risk disclosure</a></footer>
</main>
</div>
</body>
</html>
`;
}

export function buildDocs(src: string, out: string): string[] {
  const pages = readdirSync(src)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  const rendered = Object.fromEntries(
    pages.map((p) => [p, render(readFileSync(join(src, `${p}.md`), "utf8"))]),
  );
  const titles = Object.fromEntries(pages.map((p) => [p, rendered[p]?.title ?? p]));
  for (const p of pages) {
    const dir = p === "index" ? out : join(out, p);
    mkdirSync(dir, { recursive: true });
    const r = rendered[p] as { title: string; body: string };
    writeFileSync(join(dir, "index.html"), shell(r.title, r.body, p, titles));
  }
  return pages;
}

if (process.argv[1]?.endsWith("build-docs.ts"))
  console.log(buildDocs("landing/docs", process.argv[2] ?? "landing-dist/docs"));
