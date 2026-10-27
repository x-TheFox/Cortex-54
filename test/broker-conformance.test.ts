import { describe, expect, it } from "vitest";
import { SimBroker } from "../local/simbroker.ts";
import { BROKERS } from "../src/broker/registry.ts";
import type { BrokerApi } from "../src/broker/types.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memorySql } from "./sim/sqlite.ts";

/**
 * ADR-078: the contract every broker adapter must meet before it may carry orders. Run against each implementation
 * the brain can be given; a new venue's adapter is added to `cases` and must pass unchanged.
 */
const T0 = Date.parse("2026-10-27T12:00:00Z");

const cases: { name: string; make: () => { b: BrokerApi; m: Market } }[] = [
  {
    name: "sandbox (local SimBroker)",
    make: () => {
      const m = new Market(() => T0);
      m.set("BTC/USD", 100_000, 100_010);
      m.set("ETH/USD", 4_000, 4_001);
      const sql = memorySql();
      for (const s of HOT_SCHEMA) sql.exec(s);
      return { b: new SimBroker(sql, new FakeMarketData(m), 54, () => T0), m };
    },
  },
  {
    name: "test FakeBroker",
    make: () => {
      const m = new Market(() => T0);
      m.set("BTC/USD", 100_000, 100_010);
      m.set("ETH/USD", 4_000, 4_001);
      return { b: new FakeBroker(m, 54, () => T0), m };
    },
  },
];

const buy = (coid: string, limit: string, qty = "0.0002") => ({
  symbol: "BTC/USD",
  side: "buy" as const,
  type: "limit" as const,
  time_in_force: "gtc" as const,
  qty,
  limit_price: limit,
  client_order_id: coid,
});

describe.each(cases)("broker conformance: $name", ({ make }) => {
  it("reports an account with numeric equity and cash", async () => {
    const { b } = make();
    const a = await b.account();
    expect(Number(a.equity)).toBeGreaterThan(0);
    expect(Number(a.cash)).toBeGreaterThan(0);
  });

  it("client order ids are idempotent: a resubmit is refused, never doubled", async () => {
    const { b } = make();
    await b.submitOrder(buy("c54-P-aaaa0001-E-1", "90000"));
    await expect(b.submitOrder(buy("c54-P-aaaa0001-E-1", "90000"))).rejects.toThrow();
    expect((await b.openOrders()).filter((o) => o.client_order_id === "c54-P-aaaa0001-E-1")).toHaveLength(1);
  });

  it("finds an order by client id, and says null for an unknown one", async () => {
    const { b } = make();
    await b.submitOrder(buy("c54-P-aaaa0002-E-1", "90000"));
    expect((await b.orderByClientId("c54-P-aaaa0002-E-1"))?.client_order_id).toBe("c54-P-aaaa0002-E-1");
    expect(await b.orderByClientId("c54-P-nope0000-E-1")).toBeNull();
  });

  it("a marketable buy fills: the position and a fill activity appear", async () => {
    const { b } = make();
    await b.submitOrder(buy("c54-P-aaaa0003-E-1", "100100"));
    const pos = await b.positions();
    expect(pos.find((p) => p.symbol.replace("/", "") === "BTCUSD" || p.symbol === "BTC/USD")).toBeTruthy();
    expect(
      (await b.activities(null)).some(
        (a) => a.activity_type === "FILL" || (a as { type?: string }).type === "fill",
      ),
    ).toBe(true);
  });

  it("refuses to sell more than is held (cash account: no shorting)", async () => {
    const { b } = make();
    await expect(
      b.submitOrder({ ...buy("c54-P-aaaa0004-X-1", "1"), side: "sell", qty: "0.5" }),
    ).rejects.toThrow();
    expect(await b.positions()).toHaveLength(0);
  });

  it("cancels a resting order", async () => {
    const { b } = make();
    const o = await b.submitOrder(buy("c54-P-aaaa0005-E-1", "50000"));
    await b.cancelOrder(o.id);
    expect((await b.openOrders()).some((x) => x.id === o.id)).toBe(false);
    expect((await b.orderByClientId("c54-P-aaaa0005-E-1"))?.status).toBe("canceled");
  });
});

describe("broker registry", () => {
  it("lists only venues with a paper mode, each with its verification date", () => {
    expect(BROKERS.every((x) => x.paper && /\d{4}-\d{2}-\d{2}/.test(x.verified))).toBe(true);
  });
});
