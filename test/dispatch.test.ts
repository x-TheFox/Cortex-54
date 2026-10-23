import { readFileSync } from "node:fs";
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
