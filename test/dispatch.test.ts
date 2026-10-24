import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cronMatches,
  DISPATCH_GRACE_MS,
  DISPATCH_JOBS,
  dueJobs,
  latestSlot,
} from "../src/cortex/dispatch.ts";

const at = (iso: string) => Date.parse(iso);

describe("cron matcher (UTC)", () => {
  it("handles steps, ranges and day-of-week", () => {
    expect(cronMatches("7 */4 * * *", at("2026-10-23T08:07:00Z"))).toBe(true);
    expect(cronMatches("7 */4 * * *", at("2026-10-23T09:07:00Z"))).toBe(false);
    expect(cronMatches("40 12 * * 1-5", at("2026-10-23T12:40:00Z"))).toBe(true); // Friday
    expect(cronMatches("40 12 * * 1-5", at("2026-10-24T12:40:00Z"))).toBe(false); // Saturday
    expect(cronMatches("23 6 * * 0", at("2026-10-25T06:23:00Z"))).toBe(true); // Sunday
    expect(cronMatches("17 * * * *", at("2026-10-23T13:17:00Z"))).toBe(true);
    expect(() => cronMatches("* * *", 0)).toThrow();
  });

  it("finds the latest slot inside the grace window only", () => {
    expect(latestSlot("17 * * * *", at("2026-10-23T13:30:30Z"))).toBe(at("2026-10-23T13:17:00Z"));
    expect(latestSlot("17 * * * *", at("2026-10-23T13:40:00Z"))).toBeNull(); // 23 min late > 20 min grace
  });

  it("dispatches each slot once", () => {
    const now = at("2026-10-23T13:20:00Z");
    const due = dueJobs(now, {});
    expect(due.map((d) => d.job.key)).toEqual(["world"]);
    expect(dueJobs(now + 60_000, { world: due[0]?.slot ?? 0 })).toEqual([]);
    expect(DISPATCH_GRACE_MS).toBe(20 * 60_000);
  });
});

describe("dispatch table mirrors the workflow schedules", () => {
  const crons = (file: string): string[] =>
    (parse(readFileSync(`.github/workflows/${file}`, "utf8")).on.schedule as { cron: string }[]).map(
      (c) => c.cron,
    );
  it.each(["research.yml", "governor.yml"])("%s", (file) => {
    const mine = DISPATCH_JOBS.filter((j) => j.workflow === file).map((j) => j.cron);
    expect(new Set(mine)).toEqual(new Set(crons(file)));
  });
});

describe("cron matcher correctness (audit W1-19)", () => {
  /** Independent reference: expand every field to its set of allowed values, then test membership. */
  const expand = (field: string, lo: number, hi: number): Set<number> => {
    const out = new Set<number>();
    for (const part of field.split(",")) {
      const [range, stepRaw] = part.split("/") as [string, string | undefined];
      const step = stepRaw ? Number(stepRaw) : 1;
      const [a, b] =
        range === "*"
          ? [lo, hi]
          : range.includes("-")
            ? (range.split("-").map(Number) as [number, number])
            : [Number(range), stepRaw ? hi : Number(range)];
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  };
  const reference = (expr: string, ms: number): boolean => {
    const [m, h, dom, mon, dow] = expr.split(" ") as [string, string, string, string, string];
    const d = new Date(ms);
    const domOk = expand(dom, 1, 31).has(d.getUTCDate());
    const dowOk = expand(dow, 0, 6).has(d.getUTCDay());
    return (
      expand(m, 0, 59).has(d.getUTCMinutes()) &&
      expand(h, 0, 23).has(d.getUTCHours()) &&
      expand(mon, 1, 12).has(d.getUTCMonth() + 1) &&
      (dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk)
    );
  };
  const field = (lo: number, hi: number) =>
    fc.oneof(
      fc.constant("*"),
      fc.integer({ min: lo, max: hi }).map(String),
      fc
        .tuple(fc.integer({ min: lo, max: hi }), fc.integer({ min: 1, max: 12 }))
        .map(([a, s]) => `${a}/${s}`),
      fc.tuple(fc.integer({ min: 1, max: 12 })).map(([s]) => `*/${s}`),
      fc
        .tuple(fc.integer({ min: lo, max: hi }), fc.integer({ min: lo, max: hi }))
        .map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
    );

  it("agrees with a brute-force reference on 1,000 random expressions and times", () => {
    fc.assert(
      fc.property(
        fc.tuple(field(0, 59), field(0, 23), field(1, 31), field(1, 12), field(0, 6)),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) }),
        (f, t) => cronMatches(f.join(" "), Math.floor(t / 60_000) * 60_000) === reference(f.join(" "), t),
      ),
      { numRuns: 1000, seed: 54 },
    );
  });

  it("stepped hours stop at 23 and both day fields OR together", () => {
    expect(cronMatches("0 20/2 * * *", Date.UTC(2026, 9, 24, 22))).toBe(true);
    expect(cronMatches("0 1 1 * 1", Date.UTC(2026, 9, 26, 1))).toBe(true); // a Monday, not the 1st
  });
});
