import { beforeEach, describe, expect, it } from "vitest";
import type { DecisionContract } from "../src/contracts/decision-contract.ts";
import type { Doctrine } from "../src/contracts/doctrine.ts";
import { Brain } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { verifyChain } from "../src/journal/Journal.ts";
import type { AccountId } from "../src/lib/ids.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { constitution, doctrine, doctrineWith } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;

function rising(n: number, start: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 - (n - i) * 86_400_000,
    o: start + i,
    h: start + i + 1,
    l: start + i - 1,
    c: start + i,
    v: 1,
  }));
}
function flat(n: number, price: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 - (n - i) * 86_400_000,
    o: price,
    h: price + 1,
    l: price - 1,
    c: price,
    v: 1,
  }));
}

function setup(opts: { d?: Doctrine; live?: boolean; killed?: boolean } = {}) {
  let now = T0;
  const clock = () => now;
  const market = new Market(clock);
  market.bars["BTC/USD"] = rising(30, 100); // close above EMA20 → regime proxy risk-on
  market.bars["SOL/USD"] = flat(30, 100); // ATR ≈ 2, prior high 101
  market.set("SOL/USD", 100, 100.02);
  const paper = new FakeBroker(market, 54, clock);
  const live = new FakeBroker(market, 54, clock);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const d1 = memoryD1();
  const notifier = new NullNotifier();
  const kill = { on: opts.killed ?? false };
  const brokers: Partial<Record<AccountId, FakeBroker>> = { PAPER: paper };
  if (opts.live) brokers.LIVE = live;
  const brain = new Brain({
    sql,
    d: opts.d ?? doctrine,
    c: constitution,
    brokers,
    market: new FakeMarketData(market),
    notifier,
    d1,
    readKillFlag: async () => kill.on,
    now: clock,
  });
  brain.init({ test: true });
  return {
    brain,
    sql,
    d1,
    notifier,
    market,
    paper,
    live,
    kill,
    advance(ms: number) {
      now += ms;
      market.touch();
    },
  };
}

const breakout = (t: ReturnType<typeof setup>) => t.market.set("SOL/USD", 102, 102.02);

describe("Brain pulse (simulated Alpaca)", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("reconciles a flat account and does nothing without a breakout", async () => {
    const r = await t.brain.pulse();
    expect(r.accounts.PAPER?.ok).toBe(true);
    expect(r.contracts).toBe(0);
    expect(t.paper.orders.size).toBe(0);
    const s = t.brain.status();
    expect(s.accounts.find((a) => a.account === "PAPER")?.equityUsd).toBe(54);
    expect(r.nextPulseSeconds).toBe(doctrine.cadence.pulse_seconds_flat);
  });

  it("breakout → RULE contract → sized passive entry → fill → broker stop", async () => {
    breakout(t);
    const r1 = await t.brain.pulse();
    expect(r1.contracts).toBe(1);
    expect(r1.entries).toBe(1);
    const entry = [...t.paper.orders.values()][0];
    expect(entry?.side).toBe("buy");
    expect(entry?.type).toBe("limit");
    expect(entry?.limit_price).toBe("102.000"); // passive at the bid
    expect(entry?.client_order_id).toMatch(/^c54-P-[0-9a-f]{8}-E-1$/);
    // Size: risk ≤ 2.5% of $54, notional ≤ 35%.
    const qty = Number(entry?.qty);
    expect(qty * 102).toBeLessThanOrEqual(54 * 0.35);
    expect(qty * (102 - 98)).toBeLessThanOrEqual(54 * 0.025);
    expect(entry?.status).toBe("new"); // ask 102.02 > limit 102: resting

    // Seller comes down to our bid → fill.
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    const r2 = await t.brain.pulse();
    expect(r2.accounts.PAPER?.positions).toBe(1);
    const stop = [...t.paper.orders.values()].find((o) => o.type === "stop_limit");
    expect(stop?.side).toBe("sell");
    expect(stop?.time_in_force).toBe("gtc");
    expect(Number(stop?.stop_price)).toBeCloseTo(98, 2);
    expect(stop?.client_order_id).toMatch(/-S-1$/);
    const view = t.brain.status().accounts.find((a) => a.account === "PAPER");
    expect(view?.positions[0]?.brokerStop).toBe(true);
    expect(view?.modeledCostUsd).toBeGreaterThan(0); // paper is charged our fee + slippage model
    expect(r2.nextPulseSeconds).toBe(doctrine.cadence.pulse_seconds_exposed);
  });

  it("broker stop fires → position closed as STOP_BROKER with a loss", async () => {
    breakout(t);
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 97.9, 97.95);
    t.paper.tick();
    const r = await t.brain.pulse();
    expect(r.accounts.PAPER?.positions).toBe(0);
    const exit = t.sql.exec<{ reason: string; pnl_cents: number }>("SELECT reason, pnl_cents FROM exits")[0];
    expect(exit?.reason).toBe("STOP_BROKER");
    expect(exit?.pnl_cents).toBeLessThan(0);
    expect(Math.abs(exit?.pnl_cents ?? 0)).toBeLessThanOrEqual(135); // ≤ $1.35 per-trade risk
  });

  it("target hit → cancels the broker stop, exits with an IOC limit inside the collar", async () => {
    breakout(t);
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 108.5, 108.52);
    const r = await t.brain.pulse();
    expect(r.exits).toBe(1);
    const stop = [...t.paper.orders.values()].find((o) => o.type === "stop_limit");
    expect(stop?.status).toBe("canceled");
    const exit = [...t.paper.orders.values()].find((o) => o.client_order_id.includes("-X-"));
    expect(exit?.time_in_force).toBe("ioc");
    expect(exit?.status).toBe("filled");
    t.advance(60_000);
    await t.brain.pulse();
    const row = t.sql.exec<{ reason: string; pnl_cents: number }>("SELECT reason, pnl_cents FROM exits")[0];
    expect(row?.reason).toBe("TARGET");
    expect(row?.pnl_cents).toBeGreaterThan(0);
  });

  it("synthetic stop catches a gap the broker stop missed", async () => {
    breakout(t);
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    await t.brain.pulse();
    // Gap below the stop-limit's limit price: the broker stop triggers but can't fill.
    t.advance(60_000);
    t.market.set("SOL/USD", 97.0, 97.05);
    t.paper.tick();
    await t.brain.pulse();
    t.advance(60_000);
    await t.brain.pulse();
    const row = t.sql.exec<{ reason: string }>("SELECT reason FROM exits")[0];
    expect(row?.reason).toBe("STOP_SYNTHETIC");
    expect(t.paper.positionsBySymbol.size).toBe(0);
  });

  it("kill flag: no entries and resting entries are cancelled", async () => {
    breakout(t);
    await t.brain.pulse(); // resting entry
    t.kill.on = true;
    t.advance(HOUR);
    const r = await t.brain.pulse();
    expect(r.kill).toBe("KILLED");
    expect([...t.paper.orders.values()].every((o) => o.status === "canceled")).toBe(true);
  });

  it("unknown kill state (KV error) blocks entries", async () => {
    const t2 = setup();
    (t2.brain as unknown as { deps: { readKillFlag: () => Promise<boolean> } }).deps.readKillFlag =
      async () => {
        throw new Error("kv down");
      };
    breakout(t2);
    const r = await t2.brain.pulse();
    expect(r.kill).toBe("UNKNOWN");
    expect(r.entries).toBe(0);
  });

  it("journal is hash-chained and flushed to the real D1 schema", async () => {
    breakout(t);
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    await t.brain.pulse();
    const rows = t.d1.db.prepare("SELECT * FROM journal ORDER BY seq").all() as never[];
    expect(rows.length).toBeGreaterThan(3);
    expect(verifyChain(rows).ok).toBe(true);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM decision_contracts").get()).toEqual({ n: 1 });
    expect(
      (t.d1.db.prepare("SELECT origin FROM decision_contracts").get() as { origin: string }).origin,
    ).toBe("RULE");
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({ n: 1 });
    expect(() => t.d1.db.exec("UPDATE journal SET kind = 'X'")).toThrow(/append-only/);
  });

  it("keeps rows in the outbox when D1 is down and catches up later", async () => {
    t.d1.fail = true;
    breakout(t);
    await t.brain.pulse();
    expect(t.brain.journal.pending()).toBeGreaterThan(0);
    t.d1.fail = false;
    t.advance(60_000);
    await t.brain.pulse();
    await t.brain.flushJournal();
    await t.brain.flushJournal();
    expect(t.brain.journal.pending()).toBe(0);
    const rows = t.d1.db.prepare("SELECT * FROM journal ORDER BY seq").all() as never[];
    expect(verifyChain(rows).ok).toBe(true);
  });

  it("orphan position at the broker → REDUCE_ONLY and no entries", async () => {
    t.paper.positionsBySymbol.set("ETH/USD", { qty: 0.001, avg: 3000 });
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.entries).toBe(0);
    const a = t.brain.status().accounts.find((x) => x.account === "PAPER");
    expect(a?.mode).toBe("REDUCE_ONLY");
    expect(a?.modeReason).toMatch(/orphan position ETH\/USD/);
  });

  it("an account far larger than doctrine's starting equity stays reduce-only", async () => {
    t.paper.cash = 100_000;
    t.paper.lastEquity = 100_000;
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.entries).toBe(0);
    expect(t.brain.status().accounts.find((a) => a.account === "PAPER")?.modeReason).toMatch(
      /doctrine start \$54/,
    );
  });

  it("first sync skips pre-existing account history instead of alerting on it", async () => {
    t.paper.acts.push({
      id: "old-1",
      activity_type: "FILL",
      transaction_time: new Date(T0 - 3_600_000).toISOString(),
      price: "100",
      qty: "1",
      side: "buy",
      symbol: "AMD",
      order_id: "someone-else",
      net_amount: null,
    });
    await t.brain.pulse();
    expect(t.notifier.sent.filter((m) => m.channel === "alarms")).toHaveLength(0);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'UNKNOWN_FILL'").get()).toEqual({
      n: 0,
    });
    expect(
      t.d1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'ACTIVITY_BASELINE'").get(),
    ).toEqual({
      n: 1,
    });
  });

  it("budget at the hard stop blocks entries (fail closed)", async () => {
    t.brain.budget.add("do_rows_written", 95_000, T0);
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.budgetMode).toBe("REDUCE_ONLY");
    expect(r.entries).toBe(0);
  });

  it("RED breaker flattens, locks, and needs a real postmortem to unlock", async () => {
    breakout(t);
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    await t.brain.pulse();
    // Equity collapses through the RED band (cash drained to simulate a large loss elsewhere).
    t.paper.cash -= 8;
    t.advance(60_000);
    await t.brain.pulse();
    const a = t.brain.status().accounts.find((x) => x.account === "PAPER");
    expect(a?.breaker).toBe("RED");
    expect(a?.locked).toBe(true);
    expect([...t.paper.orders.values()].some((o) => o.client_order_id.includes("-X-"))).toBe(true);
    expect(t.brain.resume("PAPER", "test")).toMatch(/RED-locked/);
    expect(t.brain.unlock("PAPER", "too short", "test")).toMatch(/at least 50/);
    expect(
      t.brain.unlock(
        "PAPER",
        "Sized the baseline too large for a thin weekend market; lowered conviction.",
        "test",
      ),
    ).toMatch(/unlocked/);
  });
});

describe("risk reservations under interleaving (ADR-004)", () => {
  it("concurrent entries never exceed the slot limit", async () => {
    const d = doctrineWith((x) => {
      x.rungs.R1.max_positions = 2;
    });
    const t = setup({ d });
    t.paper.submitDelayMs = 5; // force awaits to interleave
    await t.brain.pulse(); // reconcile
    const base = (symbol: string, id: string): DecisionContract => ({
      contract_id: id,
      created_at: T0,
      schema_version: 1 as const,
      origin: "RULE" as const,
      symbol,
      arena: "CRYPTO" as const,
      strategy_id: "CRYPTO_BREAKOUT_BASELINE_V1",
      thesis_summary: `${symbol} test contract for interleaving reservations.`,
      bull_case_receipts: [{ evidence_id: "x", source_skill: "t", metric: "m", metric_value: 1, as_of: T0 }],
      bear_case_brief: "Test: concurrency guard must hold under interleaving.",
      kill_criteria: ["stop hit"],
      invalidation_criteria: { stop_price: "96", max_hold_hours: 72 },
      entry_plan: { zone_low: "99", zone_high: "101", urgency: "NORMAL" as const, targets: ["112"] },
      clef_probabilities: null,
      win_prob_used: 0.6,
      bear_lethality: 0,
      atr: 2,
      cost_and_fee_drag: {
        entry_fee_bps: 15,
        exit_fee_bps: 25,
        expected_slippage_bps: 10,
        cognitive_cost_usd: 0,
      },
      proposed_conviction: 5,
      models_used: [
        {
          role: "RULE" as const,
          provider: "cortex",
          model: "x",
          family: "deterministic",
          prompt_version: "n/a",
        },
      ],
    });
    const symbols = ["SOL/USD", "ETH/USD", "LINK/USD", "AVAX/USD"];
    const contracts = symbols.map((s, i) => base(s, `0192${i}f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0${i}`));
    for (const s of symbols) t.market.set(s, 100, 100.02);
    for (const k of contracts) t.brain.recordContract(k, T0);
    const results = await Promise.all(
      contracts.map((k) => t.brain.executeEntry("PAPER", k, { bid: 100, ask: 100.02, at: T0 })),
    );
    expect(results.filter(Boolean).length).toBe(2);
    expect([...t.paper.orders.values()].filter((o) => o.side === "buy").length).toBe(2);
  });
});

describe("autonomy policy (ADR-024/025)", () => {
  const enableLive = (d: Doctrine) => {
    const k = d.strategies.find((x) => x.id === "CRYPTO_BREAKOUT_BASELINE_V1");
    if (k) k.accounts = ["PAPER", "LIVE"];
  };

  it("PAPER trades on its own; #court gets an information card with no buttons", async () => {
    const t = setup();
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.entries).toBe(1);
    const court = t.notifier.sent.find((m) => m.channel === "court");
    expect(court?.msg.embeds?.[0]?.title).toContain("SOL/USD");
    expect(court?.msg.components).toBeUndefined();
  });

  it("there is no approve-each-trade stop; Stop 0 is shadow only", async () => {
    const t = setup();
    expect(t.brain.setDial("PAPER", 1, "test", false)).toMatch(/no approve-each-trade mode/);
    expect(t.brain.setDial("PAPER", 0, "test", false)).toMatch(/Stop 0/);
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.contracts).toBe(1);
    expect(r.entries).toBe(0);
    expect(t.paper.orders.size).toBe(0);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'SHADOW'").get()).toEqual({
      n: 1,
    });
  });

  it("LIVE is dormant by default and trades only after RATIFY at Stop 3", async () => {
    const t = setup({ live: true, d: doctrineWith(enableLive) });
    breakout(t);
    const r1 = await t.brain.pulse();
    expect(r1.entries).toBe(1); // PAPER only
    expect(t.live.orders.size).toBe(0);
    expect(t.brain.setDial("LIVE", 1, "test", true)).toMatch(/no approve-each-trade mode/);
    expect(t.brain.setDial("LIVE", 3, "test", false)).toMatch(/RATIFY/);
    expect(t.brain.setDial("LIVE", 3, "test", true)).toMatch(/Stop 3/);
  });

  it("boot migrates a retired Stop 1 dial: LIVE → 0, PAPER → 2", () => {
    const t = setup({ live: true });
    t.sql.exec("UPDATE accounts SET autonomy_stop = 1");
    t.brain.init({ test: "again" });
    const stops = Object.fromEntries(
      t.sql
        .exec<{ account: string; autonomy_stop: number }>("SELECT account, autonomy_stop FROM accounts")
        .map((r) => [r.account, r.autonomy_stop]),
    );
    expect(stops).toEqual({ PAPER: 2, LIVE: 0 });
  });

  it("PAPER recovers from RED by itself after the cooldown once flat; LIVE does not", async () => {
    const t = setup({ live: true });
    breakout(t);
    await t.brain.pulse();
    t.advance(60_000);
    t.market.set("SOL/USD", 101.99, 102);
    t.paper.tick();
    await t.brain.pulse();
    t.paper.cash -= 8; // big loss → RED → flatten
    t.live.cash -= 8;
    t.advance(60_000);
    await t.brain.pulse();
    t.advance(60_000);
    await t.brain.pulse(); // exit fills are reconciled; flat now
    const locked = (a: string) => t.brain.status().accounts.find((x) => x.account === a)?.locked;
    expect(locked("PAPER")).toBe(true);
    expect(locked("LIVE")).toBe(true);

    t.advance(doctrine.breakers.paper_auto_unlock_hours * HOUR);
    await t.brain.pulse();
    expect(locked("PAPER")).toBe(false);
    expect(t.brain.status().accounts.find((x) => x.account === "PAPER")?.mode).toBe("NORMAL");
    expect(t.notifier.sent.some((m) => m.msg.content?.includes("Automatic PAPER recovery"))).toBe(true);
    expect(locked("LIVE")).toBe(true); // constitution U5: only the operator unlocks LIVE
  });

  it("an orphan block clears itself once the orphan is gone", async () => {
    const t = setup();
    t.paper.positionsBySymbol.set("ETH/USD", { qty: 0.001, avg: 3000 });
    await t.brain.pulse();
    expect(t.brain.status().accounts.find((a) => a.account === "PAPER")?.mode).toBe("REDUCE_ONLY");
    t.paper.positionsBySymbol.delete("ETH/USD"); // operator closed it in Alpaca: value returns as cash
    t.paper.cash += 3;
    t.advance(60_000);
    await t.brain.pulse();
    const a = t.brain.status().accounts.find((x) => x.account === "PAPER");
    expect(a?.mode).toBe("NORMAL");
  });
});
