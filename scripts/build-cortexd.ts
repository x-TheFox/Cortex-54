/**
 * Bundle cortexd (the local brain + `cortex` CLI) into one file plus its resources, for the desktop app and for
 * headless installs (ADR-066):
 *
 *   dist/cortexd/cortexd.mjs     everything in local/ and src/ (zod, the Anthropic SDK…) in one ES module
 *   dist/cortexd/public/         the built web terminal
 *   dist/cortexd/migrations/     journal schema
 *   dist/cortexd/research/       the Python research package (run with uv)
 *   dist/cortexd/workers, wrangler.jsonc, config/   only what `cortex deploy` needs
 *
 * Run with: node dist/cortexd/cortexd.mjs <command>   (CORTEX_ROOT defaults to the bundle's own folder)
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const out = "dist/cortexd";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["local/cli.ts"],
  outfile: join(out, "cortexd.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
      "import { dirname as __dn } from 'node:path';import { fileURLToPath as __fu } from 'node:url';",
      "process.env.CORTEX_ROOT ??= __dn(__fu(import.meta.url));",
    ].join(""),
  },
  external: ["node:*"],
  logLevel: "warning",
  // ADR-077: the publisher's licence key is baked in at build time (empty = a build that doesn't check licences)
  define: {
    "process.env.CORTEX_LICENSE_PUBKEY_BUILTIN": JSON.stringify(process.env.CORTEX_LICENSE_PUBKEY ?? ""),
  },
});
const copy = (from: string, to = from, filter?: (p: string) => boolean) => {
  if (existsSync(from)) cpSync(from, join(out, to), { recursive: true, ...(filter ? { filter } : {}) });
};
copy("public");
copy("migrations");
copy("config");
// Closed-source product build (ADR-066): no TypeScript source ships. `cortex deploy` (own-Cloudflare mode) needs the
// worker source, so it only works from a build made with --with-cloud-deploy (internal/advanced use).
if (process.argv.includes("--with-cloud-deploy")) {
  copy("wrangler.jsonc");
  copy("src", "src");
  copy("workers/sentinel", "workers/sentinel");
}
copy("research", "research", (p) => !/(\.venv|\.vendor|__pycache__|\.pytest_cache|tests)(\/|$)/.test(p));
writeFileSync(join(out, "VERSION"), `${process.env.CORTEX_VERSION ?? "dev"} ${new Date().toISOString()}\n`);
console.log(`cortexd bundle → ${out}`);
