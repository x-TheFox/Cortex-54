import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { HubDb } from "../hub/src/handler.ts";
import {
  closeMonth,
  foundationKey,
  handleImpact,
  IMPACT_LIMITS,
  monthOf,
  type RevenueSource,
  runImpact,
  slotsFor,
  split,
  whopRevenue,
} from "../hub/src/impact.ts";

function db(): HubDb & { db: DatabaseSync } {
  const d = new DatabaseSync(":memory:");
  for (const f of ["0001_hub.sql", "0002_quotas.sql", "0003_moderation.sql", "0004_impact.sql"])
    d.exec(readFileSync(`hub/migrations/${f}`, "utf8"));
  return {
    db: d,
    all: async <T>(q: string, ...b: unknown[]) => d.prepare(q).all(...(b as never[])) as T[],
    first: async <T>(q: string, ...b: unknown[]) => (d.prepare(q).get(...(b as never[])) ?? null) as T | null,
    run: async (q: string, ...b: unknown[]) => {
      d.prepare(q).run(...(b as never[]));
    },
  };
}
const call =
  (d: HubDb, now: number, ip = "1.1.1.1") =>
  async (path: string, body?: unknown) => {
    const r = await handleImpact(
      new Request(
        `https://hub.test${path}`,
        body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      ),
      d,
      now,
      ip,
    );
    return (r as Response).json() as Promise<Record<string, unknown>>;
  };
const fixed = (gross: number, refunds = 0): RevenueSource => ({
  revenue: async () => ({ gross_cents: gross, refunds_cents: refunds, charges: 3 }),
});
const NOV = Date.UTC(2026, 10, 10);
const DEC2 = Date.UTC(2026, 11, 2);

describe("impact pledge (ADR-102)", () => {
  it("slots and splits: one foundation per $250 of pool, 1–10, cents never lost", () => {
    expect(slotsFor(0)).toBe(0);
    expect(slotsFor(5_000)).toBe(1);
    expect(slotsFor(74_000)).toBe(2);
    expect(slotsFor(10_000_000)).toBe(10);
    expect(split(100_001, 3)).toEqual([33_334, 33_334, 33_333]);
    expect(split(100_001, 3).reduce((a, b) => a + b, 0)).toBe(100_001);
  });

  it("the same foundation suggested twice merges: same domain, or the same name without suffixes", () => {
    expect(foundationKey("GiveDirectly", "https://www.givedirectly.org/donate")).toBe(
      foundationKey("Give Directly Inc.", "givedirectly.org"),
    );
    expect(foundationKey("The Against Malaria Foundation")).toBe(foundationKey("Against Malaria"));
    expect(foundationKey("Médecins Sans Frontières")).toBe(foundationKey("medecins sans frontieres"));
    expect(foundationKey("Red Cross", "https://donate.redcross.org.uk")).toBe("d:redcross.org.uk");
    expect(foundationKey("A")).not.toBe(foundationKey("B"));
  });

  it("suggest, merge duplicates as support, one vote per person per foundation per month", async () => {
    const d = db();
    const a = call(d, NOV, "a");
    const b = call(d, NOV, "b");
    expect(
      (
        await a("/v1/impact/suggest", {
          name: "GiveDirectly",
          url: "https://www.givedirectly.org",
          reason: "cash",
        })
      ).ok,
    ).toBe(true);
    const dup = await b("/v1/impact/suggest", { name: "Give Directly Inc", url: "givedirectly.org/donate" });
    expect(dup).toMatchObject({ ok: true, merged: true });
    expect((await a("/v1/impact/suggest", { name: "No site" })).ok).toBe(false);
    expect((await a("/v1/impact/vote", { id: 1 })).ok).toBe(false); // already supports it
    const v = (await a("/v1/impact")) as { suggestions: { name: string; votes: number }[] };
    expect(v.suggestions).toEqual([expect.objectContaining({ name: "GiveDirectly", votes: 2 })]);
    const lim = IMPACT_LIMITS.suggestionsPerIpPerDay;
    for (let i = 0; i < lim; i++)
      await a("/v1/impact/suggest", { name: `Fund ${i}`, url: `https://f${i}.org` });
    expect((await a("/v1/impact/suggest", { name: "One more", url: "https://more.org" })).ok).toBe(false);
  });

  it("closes a month: 20% of gross less refunds, the most supported win, equal shares, published once", async () => {
    const d = db();
    for (const [i, name] of ["Alpha Fund", "Beta Trust", "Gamma Society"].entries()) {
      await call(
        d,
        NOV,
        `s${i}`,
      )("/v1/impact/suggest", { name, url: `https://${name.split(" ")[0]?.toLowerCase()}.org` });
      for (let k = 0; k < 3 - i; k++) await call(d, NOV, `v${i}${k}`)("/v1/impact/vote", { id: i + 1 });
    }
    // $3,000 collected, $500 refunded → net $2,500 → pool $500 → 2 slots of $250
    const row = await closeMonth(d, fixed(300_000, 50_000), "2026-11", DEC2);
    expect(row).toMatchObject({ net_cents: 250_000, pool_cents: 50_000, slots: 2, status: "published" });
    const view = (await call(d, DEC2)("/v1/impact")) as {
      months: { month: string; allocations: { name: string; amount_cents: number }[] }[];
      totals: { pledged_cents: number };
    };
    expect(view.months[0]?.allocations.map((a) => [a.name, a.amount_cents])).toEqual([
      ["Alpha Fund", 25_000],
      ["Beta Trust", 25_000],
    ]);
    expect(view.totals.pledged_cents).toBe(50_000);
    // idempotent, and the record can't be rewritten
    await closeMonth(d, fixed(999_999), "2026-11", DEC2 + 1000);
    expect(d.db.prepare("SELECT SUM(amount_cents) AS s FROM impact_allocations").get()).toEqual({
      s: 50_000,
    });
    expect(() => d.db.exec("DELETE FROM impact_allocations")).toThrow(/append-only/);
    expect(() => d.db.exec("UPDATE impact_allocations SET amount_cents = 1")).toThrow(/never change/);
    d.db.exec(
      "UPDATE impact_allocations SET paid_cents = 25000, receipt_url = 'https://x.org/r' WHERE suggestion_id = 1",
    );
    // a winner sits out the next 3 months, so the next month funds Gamma first
    await runImpact(d, fixed(1_000_000), Date.UTC(2027, 0, 2));
    const jan = d.db
      .prepare("SELECT name FROM impact_allocations WHERE month = '2026-12' ORDER BY amount_cents DESC")
      .all() as { name: string }[];
    expect(jan.map((x) => x.name)).toEqual(["Gamma Society"]);
  });

  it("doesn't close a month that isn't over; no revenue source = nothing happens", async () => {
    const d = db();
    expect(await closeMonth(d, fixed(100), monthOf(NOV), NOV)).toBeNull();
    expect(await runImpact(d, null, NOV)).toMatch(/no revenue source/);
  });

  it("reads revenue from the payment processor page by page, in USD, refunds of the month subtracted", async () => {
    const pages = [
      {
        data: [
          { status: "paid", usd_total: 35 },
          { status: "paid", usd_total: 299, refunded_amount: 299, refunded_at: "2026-11-05T00:00:00Z" },
        ],
        page_info: { has_next_page: true, end_cursor: "c1" },
      },
      {
        data: [
          { status: "open", usd_total: 35 },
          { status: "paid", total: { amount: "35.00" } },
        ],
        page_info: { has_next_page: false },
      },
    ];
    let n = 0;
    const src = whopRevenue({ WHOP_API_KEY: "k", WHOP_ACCOUNT_ID: "biz_1" }, async (u) => {
      expect(u).toContain(n === 0 ? "account_id=biz_1" : "after=c1");
      return Response.json(pages[n++]);
    });
    expect(await src?.revenue(Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1))).toEqual({
      gross_cents: 36_900,
      refunds_cents: 29_900,
      charges: 3,
    });
  });
});
