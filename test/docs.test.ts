import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Audit W1-30 / W1-31 / W1-36 / W3-31: drift between code, config and docs fails CI instead of waiting for the next
 * audit. Brittle on purpose: each row is one claim a reader would act on.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("environment drift (W1-30)", () => {
  const env = read("src/env.ts");
  const wrangler = read("wrangler.jsonc");
  const example = read(".dev.vars.example");
  const optionalStrings = [...env.matchAll(/^\s+([A-Z][A-Z0-9_]+)\?: string;/gm)].map((m) => m[1] as string);
  const vars = new Set([...wrangler.matchAll(/"([A-Z][A-Z0-9_]+)"\s*:/g)].map((m) => m[1] as string));

  it("every optional secret in Env is in .dev.vars.example (or is a wrangler var)", () => {
    const missing = optionalStrings.filter((k) => !vars.has(k) && !new RegExp(`^${k}=`, "m").test(example));
    expect(missing).toEqual([]);
  });

  it("every binding in wrangler.jsonc is typed in Env", () => {
    const bindings = [...wrangler.matchAll(/"binding"\s*:\s*"([A-Z_]+)"/g)].map((m) => m[1] as string);
    expect(bindings.length).toBeGreaterThan(3);
    for (const b of bindings) expect(env, b).toMatch(new RegExp(`\\b${b}\\??:`));
  });
});

describe("vendored code (W1-31)", () => {
  it("the sentinel's verify.ts is the brain's verify.ts plus a header line", () => {
    const brain = read("src/discord/verify.ts");
    const sentinel = read("workers/sentinel/src/verify.ts");
    expect(sentinel.split("\n").slice(1).join("\n")).toBe(brain);
  });
});

describe("doc claims (W1-36)", () => {
  const absent: [string, RegExp, string][] = [
    ["docs/ARCHITECTURE.md", /ResearchSprintWorkflow(?! )/, "no Workflow class exists (ADR-050)"],
    ["docs/DATA_SOURCES.md", /DataRouter/, "there is no DataRouter (ADR-050)"],
    [
      "migrations/0001_initial_schema.sql",
      /verified on every pulse/,
      "the journal is verified daily (ADR-048)",
    ],
    ["CLAUDE.md", /approve-each-trade mode exists/, "no approve-each-trade mode (ADR-024)"],
  ];
  for (const [file, re, why] of absent)
    it(`${file} does not claim ${re}`, () => expect(read(file), why).not.toMatch(re));

  it("CLAUDE.md lists every ADR in its status log at least up to the latest one", () => {
    const latest = Math.max(
      ...[...read("docs/DECISIONS.md").matchAll(/^## ADR-(\d{3})/gm)].map((m) => Number(m[1])),
    );
    expect(read("CLAUDE.md")).toContain(`ADR-${String(latest).padStart(3, "0")}`);
  });
});

describe("ADR log (W3-31)", () => {
  const heads = [...read("docs/DECISIONS.md").matchAll(/^## (ADR-(\d{3}).*)$/gm)];
  it("headings are numbered in order, each once (one dated revision allowed), with a date", () => {
    const nums = heads.filter((h) => !/revised/.test(h[1] as string)).map((h) => Number(h[2]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    for (const h of heads) expect(h[1], h[1]).toMatch(/\(20\d\d-\d\d-\d\d\)|revised 20\d\d-\d\d-\d\d/);
  });
});
