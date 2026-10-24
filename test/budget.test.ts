import { describe, expect, it } from "vitest";
import { FreeTierBudget } from "../src/budget/FreeTierBudget.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { doctrine } from "./helpers.ts";
import { memorySql } from "./sim/sqlite.ts";

const at = (h: number) => Date.UTC(2026, 9, 24, h);

describe("free-tier budget projection (audit W1-16)", () => {
  const fresh = () => {
    const sql = memorySql();
    for (const s of HOT_SCHEMA) sql.exec(s);
    return new FreeTierBudget(sql, doctrine);
  };

  it("a morning burst that would exhaust DO writes by midnight goes THRIFT early", () => {
    const b = fresh();
    b.add("do_rows_written", 30_000, at(4)); // 30% used at 04:00 → ~180% by midnight
    const s = b.snapshot(at(4));
    expect(s.worst.fraction).toBeCloseTo(0.3);
    expect(s.projected.resource).toBe("do_rows_written");
    expect(s.mode).toBe("THRIFT");
    expect(s.resets_in_s).toBe(20 * 3600);
  });

  it("the same use late in the day is fine, and a projection never forces REDUCE_ONLY", () => {
    const b = fresh();
    b.add("do_rows_written", 30_000, at(20));
    expect(b.snapshot(at(20)).mode).toBe("NORMAL");
    const c = fresh();
    c.add("d1_rows_written", 50_000, at(2));
    expect(c.snapshot(at(2)).mode).toBe("THRIFT");
  });

  it("neuron tiers and Worker requests are not projected", () => {
    const b = fresh();
    b.add("neurons_tier1", 2_000, at(1));
    b.add("worker_requests", 20_000, at(1));
    expect(b.snapshot(at(1)).mode).toBe("NORMAL");
  });
});
