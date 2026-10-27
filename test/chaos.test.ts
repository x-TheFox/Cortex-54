import { describe, expect, it } from "vitest";
import { type BrokerApi, BrokerError, type OrderRequest } from "../src/broker/types.ts";
import { Brain } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { verifyChain } from "../src/journal/Journal.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { constitution, doctrine } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

/**
 * Chaos test (ADR-070; dossier MLP1-024): many pulses against a broker that fails at random — 5xx on reads, orders
 * rejected, orders that land but whose response is lost, cancels that error — on a random-walk market. After every
 * fault-free pulse the invariants that keep money safe must hold.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

class ChaosBroker implements BrokerApi {
  faults = true;
  lost = 0;
  injected = 0;
  constructor(
    private readonly inner: FakeBroker,
    private readonly r: () => number,
  ) {}
  private maybe(p: number, path: string): void {
    if (this.faults && this.r() < p) {
      this.injected++;
      throw new BrokerError(503, "chaos: service unavailable", path);
    }
  }
  async account() {
    this.maybe(0.08, "/v2/account");
    return this.inner.account();
  }
  async positions() {
    this.maybe(0.08, "/v2/positions");
    return this.inner.positions();
  }
  async openOrders() {
    this.maybe(0.08, "/v2/orders");
    return this.inner.openOrders();
  }
  async orderByClientId(c: string) {
    this.maybe(0.05, "/v2/orders:by_client_order_id");
    return this.inner.orderByClientId(c);
  }
  async activities(a: string | null) {
    this.maybe(0.08, "/v2/account/activities");
    return this.inner.activities(a);
  }
  async submitOrder(req: OrderRequest) {
    this.maybe(0.1, "/v2/orders");
    const o = await this.inner.submitOrder(req);
    if (this.faults && this.r() < 0.12) {
      this.lost++;
      throw new BrokerError(504, "chaos: order landed, response lost", "/v2/orders");
    }
    return o;
  }
  async cancelOrder(id: string) {
    this.maybe(0.1, "/v2/orders/cancel");
    return this.inner.cancelOrder(id);
  }
  async clock() {
    return this.inner.clock();
  }
  async asset(s: string) {
    return this.inner.asset(s);
  }
}

function run(seed: number) {
  const r = rng(seed);
  const T0 = Date.UTC(2026, 9, 22, 12);
  let now = T0;
  const market = new Market(() => now);
  const daily = (start: number): Bar[] =>
    Array.from({ length: 40 }, (_, i) => ({
      t: T0 - (40 - i) * 86_400_000,
      o: start,
      h: start + 1,
      l: start - 1,
      c: start,
      v: 1,
    }));
  market.bars["BTC/USD"] = Array.from({ length: 40 }, (_, i) => ({
    t: T0 - (40 - i) * 86_400_000,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100 + i,
    v: 1,
  }));
  market.bars["SOL/USD"] = daily(100);
  let px = 100;
  market.set("SOL/USD", px, px + 0.02);
  const fake = new FakeBroker(market, 54, () => now);
  const broker = new ChaosBroker(fake, r);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const d1 = memoryD1();
  const brain = new Brain({
    sql,
    d: doctrine,
    c: constitution,
    brokers: { PAPER: broker },
    market: new FakeMarketData(market),
    notifier: new NullNotifier(),
    d1,
    readKillFlag: async () => false,
    now: () => now,
  });
  brain.init({ chaos: seed });
  return {
    r,
    brain,
    sql,
    d1,
    fake,
    broker,
    market,
    step: (ms: number, p: number) => {
      now += ms;
      px = p;
      market.set("SOL/USD", px, px + 0.02);
      market.touch();
      fake.tick();
    },
    get px() {
      return px;
    },
  };
}

describe("chaos: random broker faults never break the money invariants (ADR-070)", () => {
  it.each([1, 7, 42, 1337])(
    "seed %i",
    async (seed) => {
      const t = run(seed);
      let p = 100;
      let checked = 0;
      for (let i = 0; i < 300; i++) {
        // a random walk with occasional breakouts above the 101 prior high and sharp drops through stops
        // oscillates through the 101 breakout level about once a day, with noise and occasional gaps both ways
        const shock = t.r() < 0.05 ? (t.r() < 0.5 ? 3 : -4) : 0;
        p = 100.6 + 2.6 * Math.sin((i * 2 * Math.PI) / 48) + (t.r() - 0.5) * 1.0 + shock;
        t.step(30 * 60_000, p);
        t.broker.faults = i % 10 !== 9;
        const report = await t.brain.pulse(); // must never throw
        expect(report).toBeTruthy();
        if (t.broker.faults) continue;
        checked++;
        // 1. hot state agrees with the broker about what is held. Fills are read at the start of the next pulse, so an
        //    exit or entry that filled during this pulse may lag by one pulse — but only in that explainable way.
        const hot = t.sql.exec<{
          symbol: string;
          qty: string;
          stop_price: string;
          avg_entry: string;
          state: string;
        }>("SELECT symbol, qty, stop_price, avg_entry, state FROM positions");
        const live = [...t.fake.positionsBySymbol.entries()].filter(([, v]) => v.qty > 1e-9).map(([k]) => k);
        for (const h of hot.filter((x) => !live.includes(x.symbol)))
          expect(h.state, `${h.symbol} gone at broker`).toBe("EXITING");
        for (const s of live.filter((x) => !hot.some((h) => h.symbol === x))) {
          const pending = t.sql.exec("SELECT 1 AS x FROM orders WHERE symbol = ? AND role = 'ENTRY'", s);
          expect(pending.length, `${s} held at broker but unknown to the brain`).toBeGreaterThan(0);
        }
        // 2. every position has an exit (U4), and its stop only ever moved up from where it started (ADR-059)
        for (const h of hot) {
          expect(Number(h.stop_price)).toBeGreaterThan(0);
          const w = t.sql.exec<{ initial_stop: number }>(
            "SELECT initial_stop FROM position_watch WHERE symbol = ?",
            h.symbol,
          )[0];
          if (w) expect(Number(h.stop_price)).toBeGreaterThanOrEqual(w.initial_stop - 1e-9);
        }
        // 3. never two live entry orders for the same symbol, never a duplicate client order id
        const open = [...t.fake.orders.values()].filter((o) =>
          ["new", "accepted", "partially_filled"].includes(o.status),
        );
        const entries = open.filter((o) => o.side === "buy").map((o) => o.symbol);
        expect(new Set(entries).size).toBe(entries.length);
        const ids = [...t.fake.orders.values()].map((o) => o.client_order_id);
        expect(new Set(ids).size).toBe(ids.length);
        // 4. never more than the constitution's notional per position (35% of equity, with fill slippage room)
        for (const [s, v] of t.fake.positionsBySymbol)
          expect(v.qty * (t.market.quotes[s]?.bid ?? 0)).toBeLessThanOrEqual(54 * 0.35 * 1.25);
      }
      // settle: three fault-free pulses on a frozen market → the brain and the broker agree exactly
      t.broker.faults = false;
      for (let k = 0; k < 3; k++) {
        t.step(60_000, t.px);
        await t.brain.pulse();
      }
      t.fake.tick();
      await t.brain.pulse();
      const finalHot = t.sql
        .exec<{ symbol: string }>("SELECT symbol FROM positions WHERE state = 'OPEN'")
        .map((x) => x.symbol)
        .sort();
      const finalLive = [...t.fake.positionsBySymbol.entries()]
        .filter(([, v]) => v.qty > 1e-9)
        .map(([k]) => k)
        .sort();
      expect(finalHot).toEqual(finalLive);
      expect(checked).toBeGreaterThan(20);
      expect(t.broker.injected + t.broker.lost).toBeGreaterThan(10); // faults really happened
      // and trading really happened through them: entries filled and positions were closed
      expect(t.fake.acts.filter((a) => a.side === "buy").length).toBeGreaterThanOrEqual(2);
      expect(t.sql.exec("SELECT * FROM exits").length).toBeGreaterThan(1);
      // 5. cash never goes negative (no margin, no shorting)
      expect(t.fake.cash).toBeGreaterThanOrEqual(-1e-6);
      // 6. the journal hash chain is intact after all of it
      await t.brain.flushJournal();
      const rows = t.d1.db
        .prepare("SELECT seq, ts, kind, payload_json, prev_row_sha256, row_sha256 FROM journal ORDER BY seq")
        .all() as never[];
      expect(verifyChain(rows).ok).toBe(true);
    },
    30_000,
  ); // hundreds of pulses: slow under a full parallel run
});
