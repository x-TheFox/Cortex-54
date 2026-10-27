/**
 * Builds the landing page (ADR-084) into landing-dist/: the page itself, then the demo cockpit (ADR-077) into
 * landing-dist/demo/ so the page's demo button opens it from the same origin. The cockpit's Worker-only files
 * (_headers, the service worker) are dropped, as the Pages deploy always did.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const run = (args: string[]) => execFileSync("pnpm", ["exec", ...args], { stdio: "inherit" });

run(["vite", "build", "--config", "landing/vite.config.ts"]);
run(["vite", "build", "--config", "web/vite.demo.config.ts", "--outDir", "../landing-dist/demo"]);
for (const f of ["landing-dist/demo/_headers", "landing-dist/demo/sw.js"]) if (existsSync(f)) rmSync(f);
if (!existsSync("landing-dist/index.html") || !existsSync("landing-dist/demo/index.html")) {
  throw new Error("landing build incomplete");
}
console.log("landing → landing-dist/ (demo cockpit at landing-dist/demo/)");
