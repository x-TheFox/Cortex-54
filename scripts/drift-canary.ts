/** Weekly model drift canary (ADR-070): `pnpm canary` with the court's keys in the environment. Prints JSON. */

import { hopsOf, runCanary } from "../src/court/canary.ts";
import { buildPool, parsePool } from "../src/court/pool.ts";
import { buildProviders } from "../src/court/providers.ts";
import { DOCTRINE } from "../src/generated/config.ts";

const env = process.env as Record<string, string | undefined>;
const built = buildPool(DOCTRINE, buildProviders(env), parsePool(env.LLM_POOL));
const r = await runCanary(built.providers, hopsOf(built.d), Date.now());
console.log(JSON.stringify(r, null, 2));
const bad = r.results.filter((x) => !x.schema_ok);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Model drift canary (${r.prompt})\n\n| model | answered | schema | ms |\n|---|---|---|---|\n${r.results
      .map(
        (x) =>
          `| ${x.provider}/${x.model} | ${x.ok ? "✅" : "❌"} | ${x.schema_ok ? "✅" : "❌"} | ${x.ms} |`,
      )
      .join("\n")}\n`,
  );
}
process.exitCode = bad.length === r.results.length && r.results.length > 0 ? 1 : 0;
