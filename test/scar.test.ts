import { describe, expect, it } from "vitest";
import { reputationKey, ScarTissueSchema, scarLessons, scarVetoes } from "../src/risk/scar.ts";

const ev = ["k1", "k2", "k3"];
const rule = (over: Record<string, unknown> = {}) => ({
  id: "SCAR-001",
  kind: "hard_filter",
  rule: "No SOL/USD breakouts while crypto posture is REDUCE_ONLY.",
  expression: {
    all: [
      { field: "symbol", op: "==", value: "SOL/USD" },
      { field: "posture", op: "in", value: ["REDUCE_ONLY", "CASH_PRIORITY"] },
    ],
    action: "reject",
  },
  evidence: ev,
  added: "2026-10-23",
  ...over,
});
const tissue = (rules: unknown[]) => ScarTissueSchema.parse({ version: 1, rules });

describe("scar tissue schema", () => {
  it("requires ≥3 evidence, an expression for hard filters, unique ids", () => {
    expect(ScarTissueSchema.safeParse({ version: 1, rules: [rule({ evidence: ["k1"] })] }).success).toBe(
      false,
    );
    expect(ScarTissueSchema.safeParse({ version: 1, rules: [rule({ expression: undefined })] }).success).toBe(
      false,
    );
    expect(ScarTissueSchema.safeParse({ version: 1, rules: [rule(), rule()] }).success).toBe(false);
    expect(
      ScarTissueSchema.safeParse({
        version: 1,
        rules: [rule({ expression: { all: [{ field: "made_up", op: "==", value: 1 }], action: "reject" } })],
      }).success,
    ).toBe(false);
    expect(ScarTissueSchema.parse({ version: 1, rules: null }).rules).toEqual([]);
  });
});

describe("scar vetoes", () => {
  const t = tissue([rule()]);
  it("vetoes only when every condition matches", () => {
    expect(
      scarVetoes(t.rules, { symbol: "SOL/USD", posture: "REDUCE_ONLY", arena: "CRYPTO" }, "2026-10-23"),
    ).toHaveLength(1);
    expect(
      scarVetoes(t.rules, { symbol: "SOL/USD", posture: "NEW_ENTRY_ALLOWED" }, "2026-10-23"),
    ).toHaveLength(0);
    expect(scarVetoes(t.rules, { symbol: "BTC/USD", posture: "REDUCE_ONLY" }, "2026-10-23")).toHaveLength(0);
  });
  it("unknown facts never match; expiry and arena scope apply", () => {
    expect(scarVetoes(t.rules, { symbol: "SOL/USD", posture: null }, "2026-10-23")).toHaveLength(0);
    const exp = tissue([rule({ expires: "2026-11-01" })]);
    const f = { symbol: "SOL/USD", posture: "REDUCE_ONLY", arena: "CRYPTO" };
    expect(scarVetoes(exp.rules, f, "2026-11-01")).toHaveLength(1);
    expect(scarVetoes(exp.rules, f, "2026-11-02")).toHaveLength(0);
    const eq = tissue([rule({ arena: "EQUITIES" })]);
    expect(scarVetoes(eq.rules, f, "2026-10-23")).toHaveLength(0);
  });
  it("numeric comparisons", () => {
    const n = tissue([
      rule({ expression: { all: [{ field: "utc_hour", op: ">=", value: 22 }], action: "reject" } }),
    ]);
    expect(scarVetoes(n.rules, { utc_hour: 23 }, "2026-10-23")).toHaveLength(1);
    expect(scarVetoes(n.rules, { utc_hour: 3 }, "2026-10-23")).toHaveLength(0);
  });
  it("context rules become lessons, not vetoes", () => {
    const c = tissue([rule({ kind: "context", expression: undefined, arena: "CRYPTO" })]);
    expect(scarVetoes(c.rules, { symbol: "SOL/USD", posture: "REDUCE_ONLY" }, "2026-10-23")).toHaveLength(0);
    expect(scarLessons(c.rules, "CRYPTO", "2026-10-23")[0]).toMatch(/^SCAR-001: /);
    expect(scarLessons(c.rules, "EQUITIES", "2026-10-23")).toEqual([]);
  });
  it("reputation keys", () => {
    expect(reputationKey("news", "Benzinga")).toBe("news:benzinga");
    expect(reputationKey("press_release", "prnewswire.com")).toBe("press_release");
  });
});
