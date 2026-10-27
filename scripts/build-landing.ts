/**
 * Builds the landing page (ADR-084) into landing-dist/: the page itself, then the demo cockpit (ADR-077) into
 * landing-dist/demo/ so the page's demo button opens it from the same origin. The cockpit's Worker-only files
 * (_headers, the service worker) are dropped, as the Pages deploy always did.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocs } from "./build-docs.ts";
import { buildLegal, page } from "./build-legal.ts";

const run = (args: string[]) => execFileSync("pnpm", ["exec", ...args], { stdio: "inherit" });

run(["vite", "build", "--config", "landing/vite.config.ts"]);
run(["vite", "build", "--config", "web/vite.demo.config.ts", "--outDir", "../landing-dist/demo"]);
for (const f of ["landing-dist/demo/_headers", "landing-dist/demo/sw.js"]) if (existsSync(f)) rmSync(f);
buildLegal(["landing-dist/legal"]); // ADR-087: terms, EULA, privacy, refunds, risk
buildDocs("landing/docs", "landing-dist/docs"); // ADR-093: install guide and help
// and the third-party notices, the same file every installer ships
const tp = join(mkdtempSync(join(tmpdir(), "savant-tp-")), "THIRD_PARTY_NOTICES.md");
execFileSync("pnpm", ["exec", "tsx", "scripts/third-party.ts", tp], { stdio: "inherit" });
writeFileSync("landing-dist/legal/third-party.html", page(readFileSync(tp, "utf8")).html);
// ADR-090: Vercel serves landing-dist as a static site; its headers and redirects (downloads, updates) travel with it
// ADR-092: the redirects name the public repository that holds the installers (the source repository is private)
const releases = process.env.SAVANT_RELEASES_REPO ?? "x-TheFox/Cortex-54";
if (!/^[\w.-]+\/[\w.-]+$/.test(releases)) throw new Error("SAVANT_RELEASES_REPO must look like owner/repo");
writeFileSync(
  "landing-dist/vercel.json",
  readFileSync("landing/vercel.json", "utf8").replaceAll("x-TheFox/Cortex-54", releases),
);
if (!existsSync("landing-dist/index.html") || !existsSync("landing-dist/demo/index.html")) {
  throw new Error("landing build incomplete");
}
console.log("landing → landing-dist/ (demo cockpit at landing-dist/demo/)");
