import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ADR-084: the landing page sells the product, so its copy is held to the claims list in CORTEX_LEDGER.md §14.
// Brittle on purpose, like test/docs.test.ts.
const html = readFileSync(new URL("../landing/index.html", import.meta.url), "utf8");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("landing page claims (ADR-084)", () => {
  it.each([
    [/notari[sz]ed/i, "notarization is conditional on secrets"],
    [/approve (each )?trades?\b(?! — there is no)/i, "no approve-each-trade mode exists"],
    [/guarantee[sd]? (returns|profit)/i, "no return promises"],
    [/\bper month\b|\/mo\b|pricing|free trial/i, "no prices exist yet"],
    [/testimonial|trusted by|customers love/i, "no invented social proof"],
    [/docker/i, "the headless image has never run in a container"],
    [/community hub/i, "the hub is not deployed"],
  ])("does not claim %s (%s)", (re) => {
    expect(text).not.toMatch(re);
  });

  it("keeps LIVE dormant, the demo labelled, and the risk section linked from the hero", () => {
    expect(text).toMatch(/LIVE · dormant at Stop 0/);
    expect(text).toMatch(/synthetic data/);
    expect(html).toMatch(/id="risk"/);
    expect(html.slice(0, html.indexOf('id="process"'))).toMatch(/href="#risk"/);
  });

  it("is a closed-source product: no source or release links, buying goes to checkout", () => {
    const llms = readFileSync(new URL("../landing/public/llms.txt", import.meta.url), "utf8");
    expect(html).not.toMatch(/github/i);
    expect(llms).not.toMatch(/github/i);
    expect(html).not.toMatch(/download the latest release/i);
    expect(html.match(/href="%%CHECKOUT_HREF%%"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("sells any account size, not only $54", () => {
    expect(text).toMatch(/any size/);
    expect(html).toContain("%%RUNG_ROWS%%");
    expect(text).not.toMatch(/Two \$54 accounts|starting from \$54/);
  });

  it("prints engine numbers from config, not by hand", () => {
    for (const t of ["%%CONSTITUTION_ARTICLES%%", "%%RUNG_ROWS%%", "%%T3_PER_DAY%%", "%%B_RED%%"]) {
      expect(html).toContain(t);
    }
  });
});
