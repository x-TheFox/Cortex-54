import { describe, expect, it } from "vitest";
import { weekdayMsBetween } from "../src/lib/time.ts";

const H = 3_600_000;

describe("weekdayMsBetween", () => {
  it("skips Saturday and Sunday (UTC)", () => {
    const fri = Date.UTC(2026, 9, 23, 21, 20);
    const mon = Date.UTC(2026, 9, 26, 12, 40);
    expect(weekdayMsBetween(fri, mon) / H).toBeCloseTo(2 + 40 / 60 + 12 + 40 / 60);
  });
  it("is plain elapsed time inside a week, and zero for reversed ranges", () => {
    const tue = Date.UTC(2026, 9, 20, 6, 0);
    expect(weekdayMsBetween(tue, tue + 30 * H)).toBe(30 * H);
    expect(weekdayMsBetween(tue, tue - H)).toBe(0);
    expect(weekdayMsBetween(Date.UTC(2026, 9, 24), Date.UTC(2026, 9, 25, 23))).toBe(0);
  });
});
