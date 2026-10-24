import { beforeEach, describe, expect, it } from "vitest";
import type { ClefAnswer, ClefApi, ClefQuestion, ClefResult } from "../src/clef/ClefClient.ts";
import type { DecisionContract } from "../src/contracts/decision-contract.ts";
import type { Doctrine } from "../src/contracts/doctrine.ts";
import { Brain, equityChartUrl, terminalLine } from "../src/cortex/Brain.ts";
import type { WorkflowDispatcher } from "../src/cortex/dispatch.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { type LlmProvider, LlmRouter } from "../src/court/llm.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { verifyChain } from "../src/journal/Journal.ts";
import type { AccountId } from "../src/lib/ids.ts";
import { type ScarTissue, ScarTissueSchema } from "../src/risk/scar.ts";
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

function setup(
  opts: {
    d?: Doctrine;
    live?: boolean;
    killed?: boolean;
    clef?: ClefApi;
    llm?: LlmRouter;
    dispatcher?: WorkflowDispatcher;
    scar?: ScarTissue;
  } = {},
) {
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
    clef: opts.clef ?? null,
    llm: opts.llm ?? null,
    dispatcher: opts.dispatcher ?? null,
    scar: opts.scar ?? null,
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
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'KILL_SEEN'").get()).toEqual({
      n: 1,
    });
    t.kill.on = false;
    t.advance(60_000);
    await t.brain.pulse();
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'KILL_CLEARED'").get()).toEqual({
      n: 1,
    });
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

describe("research batch ingest (Phase 2)", () => {
  const batch = (
    over: {
      score?: number;
      posture?: "NEW_ENTRY_ALLOWED" | "REDUCE_ONLY" | "CASH_PRIORITY";
      producedAt?: number;
    } = {},
  ) => ({
    schema_version: 1,
    job: "crypto-regime",
    produced_at: over.producedAt ?? T0,
    run_url: "https://github.com/x-TheFox/Cortex-54/actions/runs/1",
    items: [
      {
        skill_id: "crypto-regime-analyzer",
        version: "cb0f3aadffed6d1089db4b224162c964368baa46",
        as_of: T0,
        inputs_sha256: "a".repeat(64),
        payload: { headline: "NEUTRAL 66.8", composite: { score: over.score ?? 66.8 } },
      },
    ],
    posture: {
      arena: "CRYPTO",
      posture: over.posture ?? "NEW_ENTRY_ALLOWED",
      score: over.score ?? 66.8,
      ceiling: null,
      confidence: null,
      summary: "Mixed conditions.",
    },
  });

  it("stores the batch in D1, updates regime state, and posts a posture card", async () => {
    const t = setup();
    const r = await t.brain.ingestBatch(batch());
    expect(r.ok).toBe(true);
    expect(t.d1.db.prepare("SELECT job, skill_id FROM batch_results").get()).toEqual({
      job: "crypto-regime",
      skill_id: "crypto-regime-analyzer",
    });
    expect(t.brain.status().regimes.find((x) => x.arena === "CRYPTO")?.score).toBeCloseTo(66.8);
    const card = t.notifier.sent.find(
      (m) => m.channel === "briefs" && m.msg.embeds?.[0]?.title?.includes("Crypto regime"),
    );
    expect(card).toBeDefined();
  });

  it("rejects payloads that fail the schema", async () => {
    const t = setup();
    expect((await t.brain.ingestBatch({ ...batch(), job: "rm -rf" })).ok).toBe(false);
    expect((await t.brain.ingestBatch({ ...batch(), items: [] })).ok).toBe(false);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM batch_results").get()).toEqual({ n: 0 });
  });

  it("a fresh batch below the composite minimum blocks crypto longs even if the BTC proxy is risk-on", async () => {
    const t = setup();
    await t.brain.ingestBatch(batch({ score: 30, posture: "REDUCE_ONLY" }));
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.contracts).toBe(0);
  });

  it("a stale batch falls back to the proxy and raises one staleness alarm", async () => {
    const t = setup();
    await t.brain.ingestBatch(batch({ score: 30, posture: "REDUCE_ONLY", producedAt: T0 - 7 * HOUR }));
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.contracts).toBe(1); // proxy says risk-on; stale batch is ignored
    expect(t.notifier.sent.filter((m) => m.msg.content?.includes("regime batch is"))).toHaveLength(1);
  });
});

describe("news intake (Phase 2)", () => {
  const item = (id: string, minutesAgo: number, symbols = ["BTCUSD"]) => ({
    id,
    createdAt: T0 - minutesAgo * 60_000,
    headline: `Headline ${id}`,
    summary: "s",
    symbols,
    source: "benzinga",
    url: null,
  });

  it("queues new headlines for watched symbols once, and moves the cursor", async () => {
    const t = setup();
    t.market.news.push(item("1", 30), item("2", 10), item("3", 5, ["PLTR"]));
    const r1 = await t.brain.pulse();
    expect(r1.newsQueued).toBe(2); // PLTR isn't watched or held
    t.advance(60_000);
    const r2 = await t.brain.pulse();
    expect(r2.newsQueued).toBe(0);
    t.market.news.push({ ...item("4", 0), createdAt: T0 + 30_000 });
    t.advance(60_000);
    expect((await t.brain.pulse()).newsQueued).toBe(1);
    expect(
      t.sql.exec("SELECT candidate_id FROM triage_queue ORDER BY candidate_id").map((r) => r.candidate_id),
    ).toEqual(["news:1", "news:2", "news:4"]);
  });

  it("a news failure never blocks trading", async () => {
    const t = setup();
    (t.brain as unknown as { deps: { market: { news: () => Promise<never> } } }).deps.market.news =
      async () => {
        throw new Error("news down");
      };
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.entries).toBe(1);
  });
});

/** Fake Clef answering in the real response format; `material` decides per item headline. */
class FakeClef implements ClefApi {
  calls: { model: string; questions: Record<string, ClefQuestion> }[] = [];
  fail: Error | null = null;
  constructor(
    private readonly material: (headline: string) => number,
    private readonly escalate: (headline: string) => number = () => 2.6,
  ) {}
  async run(
    model: "clef-flash" | "clef",
    state: unknown,
    questions: Record<string, ClefQuestion>,
  ): Promise<ClefResult> {
    this.calls.push({ model, questions });
    if (this.fail) throw this.fail;
    const items = (state as { items: { headline: string }[] }).items;
    const answers: ClefResult["answers"] = {};
    for (const id of Object.keys(questions)) {
      const h = items[Number(id.slice(1, id.indexOf(".")))]?.headline ?? "";
      if (id.endsWith(".material")) answers[id] = { type: "noul", noul: this.material(h) };
      if (id.endsWith(".direction"))
        answers[id] = { type: "choice", choice: "up", probabilities: { up: 0.8, down: 0.1, unclear: 0.1 } };
      if (id.endsWith(".escalate")) answers[id] = { type: "score", score: this.escalate(h) };
    }
    return { model, answers, usage: { input_tokens: 1000, output_tokens: 0 } };
  }
}

describe("Tier 1 triage (Phase 3)", () => {
  const news = (id: string) => ({
    id,
    createdAt: T0 - 5 * 60_000,
    headline: `Headline ${id}`,
    summary: "s",
    symbols: ["BTCUSD"],
    source: "benzinga",
    url: null,
  });

  it("promotes material, high-priority items to tier 2, drops the rest, logs and meters", async () => {
    const clef = new FakeClef((h) => (h === "Headline 1" ? 0.9 : 0.3));
    const t = setup({ clef });
    t.market.news.push(news("1"), news("2"), news("3"));
    const r = await t.brain.pulse();
    expect(r.triaged).toBe(3);
    expect(r.promoted).toBe(1);
    expect(clef.calls).toHaveLength(3); // one item per call (ADR-027)
    expect(clef.calls[0]?.model).toBe("clef-flash");
    expect(Object.keys(clef.calls[0]?.questions ?? {})).toHaveLength(3);
    // The promoted item went straight on to Tier 2 in the same pulse, where the Tier 0 crypto gate (no fresh
    // regime batch, proxy not consulted for candidates) rejected it before any Clef 27B call.
    expect(t.sql.exec("SELECT candidate_id FROM triage_queue")).toHaveLength(0);
    expect(
      t.d1.db.prepare("SELECT stage, reason_codes FROM rejections WHERE candidate_id = 'news:1'").get(),
    ).toEqual({ stage: "TIER0", reason_codes: '["crypto regime gate closed (stale)"]' });
    expect(clef.calls.every((c) => c.model === "clef-flash")).toBe(true);
    expect(t.notifier.sent.filter((m) => m.channel === "world_intel")).toHaveLength(1);
    expect(t.d1.db.prepare("SELECT tier, model FROM triage_log").get()).toEqual({
      tier: 1,
      model: "clef-flash",
    });
    expect(t.brain.budget.used("neurons_tier1", T0)).toBeCloseTo((3 * 1000 * 3455) / 1e6, 6);
  });

  it("drops items whose answers are missing (fail closed)", async () => {
    const clef = new FakeClef(() => 0.95);
    clef.run = async (model, _s, questions) => ({
      model,
      answers: { [Object.keys(questions)[0] as string]: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const t = setup({ clef });
    t.market.news.push(news("1"));
    const r = await t.brain.pulse();
    expect(r.promoted).toBe(0);
    expect(t.sql.exec("SELECT candidate_id FROM triage_queue")).toHaveLength(0);
  });

  it("skips the call when the tier-1 neuron allocation is spent", async () => {
    const clef = new FakeClef(() => 0.9);
    const t = setup({ clef });
    t.brain.budget.add("neurons_tier1", 3000, T0);
    t.market.news.push(news("1"));
    const r = await t.brain.pulse();
    expect(clef.calls).toHaveLength(0);
    expect(r.triaged).toBe(0);
    expect(t.sql.exec("SELECT candidate_id FROM triage_queue")).toHaveLength(1); // waits for tomorrow
  });

  it("a Workers AI quota error stops tier 1 for the day but never blocks trading", async () => {
    const clef = new FakeClef(() => 0.9);
    clef.fail = new Error("4006: you have used up your daily free allocation of 10,000 neurons");
    const t = setup({ clef });
    t.market.news.push(news("1"));
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.entries).toBe(1);
    expect(t.brain.budget.canSpendNeurons("neurons_tier1", 1, T0)).toBe(false);
  });
});

describe("world-intel ingest (GDELT / EDGAR)", () => {
  const worldBatch = (candidates: unknown[]) => ({
    schema_version: 1,
    job: "world-intel",
    produced_at: T0,
    run_url: null,
    items: [
      {
        skill_id: "gdelt-world-pulse",
        version: "gdelt-v1",
        as_of: T0,
        inputs_sha256: "b".repeat(64),
        payload: { candidates },
      },
    ],
    posture: null,
  });
  const cand = (id: string, kind = "gdelt") => ({
    id,
    kind,
    title: `Fed signals ${id}`,
    url: "https://example.com/a",
    symbols: ["SPY"],
    source: "example.com",
    published_at: T0 - 60_000,
    topic: "federal reserve",
  });

  it("queues valid candidates once and ignores malformed ones", async () => {
    const t = setup();
    const r1 = await t.brain.ingestBatch(
      worldBatch([cand("a"), cand("b", "edgar"), { id: "x", kind: "rumor" }]),
    );
    expect(r1).toEqual({ ok: true, message: "queued 2 world-intel candidate(s)" });
    const r2 = await t.brain.ingestBatch(worldBatch([cand("a")]));
    expect(r2.message).toBe("queued 0 world-intel candidate(s)");
    expect(
      t.sql.exec("SELECT candidate_id FROM triage_queue ORDER BY candidate_id").map((x) => x.candidate_id),
    ).toEqual(["edgar:b", "gdelt:a"]);
  });

  it("requires posture for regime jobs and forbids it for world-intel", async () => {
    const t = setup();
    expect((await t.brain.ingestBatch({ ...worldBatch([cand("a")]), job: "crypto-regime" })).ok).toBe(false);
  });
});

/** Clef that answers by question id (item prefixes like "i0." stripped), in the real response format. */
class ScriptedClef implements ClefApi {
  calls: string[] = [];
  constructor(private readonly a: Record<string, ClefAnswer>) {}
  async run(
    model: "clef-flash" | "clef",
    _state: unknown,
    questions: Record<string, ClefQuestion>,
  ): Promise<ClefResult> {
    this.calls.push(model);
    const answers: ClefResult["answers"] = {};
    for (const id of Object.keys(questions)) {
      const a = this.a[id.replace(/^i\d+\./, "")];
      if (a) answers[id] = a;
    }
    return { model, answers, usage: { input_tokens: 800, output_tokens: 0 } };
  }
}

describe("court end-to-end (Phase 3)", () => {
  const answers: Record<string, ClefAnswer> = {
    material: { type: "noul", noul: 0.9 },
    direction: { type: "choice", choice: "up", probabilities: { up: 0.9, down: 0.05, unclear: 0.05 } },
    escalate: { type: "score", score: 2.7 },
    long_favored: { type: "noul", noul: 0.82 },
    regime_alignment: { type: "noul", noul: 0.8 },
    bear_lethality: { type: "noul", noul: 0.3 },
    setup_class: {
      type: "choice",
      choice: "momentum_continuation",
      probabilities: { momentum_continuation: 0.8 },
    },
    structural_quality: { type: "score", score: 3.4 },
    win_prob: { type: "noul", noul: 0.7 },
    regime_fit: { type: "noul", noul: 0.7 },
    suitability: { type: "score", score: 3 },
  };
  const bullJson = JSON.stringify({
    no_trade: false,
    thesis: "Record ETF inflows extend BTC's uptrend; invalid below 126.",
    setup: "momentum_continuation",
    entry_low: 129.5,
    entry_high: 130.5,
    stop: 126,
    targets: [136],
    horizon_hours: 48,
    conviction: 7,
    receipts: ["close", "atr14", "catalyst"],
  });
  const bearJson = JSON.stringify({
    fatal_flaws: ["Price is stretched above EMA20"],
    kill_criteria: ["Daily close below 126"],
    lethality: 0.3,
    brief: "Momentum is extended versus ATR and inflow headlines often mark short-term tops.",
  });
  const provider = (text: string, calls: string[]): LlmProvider => ({
    async complete(model) {
      calls.push(model);
      return { text, inputTokens: 100, outputTokens: 50 };
    },
  });
  const cryptoBatch = {
    schema_version: 1,
    job: "crypto-regime",
    produced_at: T0,
    run_url: null,
    items: [
      {
        skill_id: "crypto-regime-analyzer",
        version: "x",
        as_of: T0,
        inputs_sha256: "c".repeat(64),
        payload: {},
      },
    ],
    posture: {
      arena: "CRYPTO",
      posture: "NEW_ENTRY_ALLOWED",
      score: 66,
      ceiling: null,
      confidence: null,
      summary: "ok",
    },
  };
  const btcNews = {
    id: "77",
    createdAt: T0 - 5 * 60_000,
    headline: "Bitcoin ETF inflows hit a record",
    summary: "s",
    symbols: ["BTCUSD"],
    source: "benzinga",
    url: null,
  };

  it("headline → Tier 1 → Tier 2 → bull/bear/synth → COURT contract → paper order", async () => {
    const calls: string[] = [];
    let now = T0;
    const llm = new LlmRouter(
      { gemini: provider(bullJson, calls), groq: provider(bearJson, calls) },
      doctrine,
      () => now,
    );
    const clef = new ScriptedClef(answers);
    const t = setup({ clef, llm });
    now = T0;
    await t.brain.ingestBatch(cryptoBatch);
    t.market.set("BTC/USD", 130, 130.02);
    t.market.news.push(btcNews);
    const r = await t.brain.pulse();
    expect(r.promoted).toBe(1);
    expect(r.tier2).toBe(1);
    expect(r.courtContracts).toBe(1);
    expect(calls).toEqual(["gemini-3.5-flash", "openai/gpt-oss-120b"]); // bull google, bear openai-oss
    expect(clef.calls).toEqual(["clef-flash", "clef", "clef"]); // tier1, tier2, synth
    const k = t.d1.db
      .prepare("SELECT origin, strategy_id, models_used FROM decision_contracts WHERE origin = 'COURT'")
      .get() as {
      origin: string;
      strategy_id: string;
      models_used: string;
    };
    expect(k.strategy_id).toBe("CRYPTO_CATALYST_COURT_V1");
    expect(JSON.parse(k.models_used).map((m: { family: string }) => m.family)).toEqual([
      "google",
      "openai-oss",
      "cloudflare-clef",
    ]);
    const buy = [...t.paper.orders.values()].find((o) => o.side === "buy" && o.symbol === "BTC/USD");
    expect(buy?.limit_price).toBe("130.000");
    expect(Number(buy?.qty) * (130 - 126)).toBeLessThanOrEqual(54 * 0.025);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE outcome = 'OK'").get()).toEqual({
      n: 2,
    });
    const card = t.notifier.sent.find(
      (m) => m.channel === "court" && m.msg.embeds?.[0]?.title?.startsWith("⚖️ Court"),
    );
    const names = card?.msg.embeds?.[0]?.fields?.map((f) => f.name) ?? [];
    expect(names.some((n) => n.startsWith("🐂 Bull · gemini/gemini-3.5-flash"))).toBe(true);
    expect(names.some((n) => n.startsWith("🐻 Bear · groq/openai/gpt-oss-120b"))).toBe(true);
    expect(names).toContain("⚖️ Clef 27B verdict");
    expect(card?.msg.embeds?.[0]?.fields?.at(-1)?.value).toContain("PAPER: entry order placed");
  });

  it("/court runs a session on demand and posts the card even when declined", async () => {
    const calls: string[] = [];
    const llm = new LlmRouter({ gemini: provider(bullJson, calls) }, doctrine, () => T0); // no bear family
    const t = setup({ clef: new ScriptedClef(answers), llm });
    await t.brain.ingestBatch(cryptoBatch);
    t.market.set("BTC/USD", 130, 130.02);
    expect(await t.brain.requestCourt("BTC/USD", "test")).toMatch(/ended without a contract/);
    const card = t.notifier.sent.find((m) => m.channel === "court");
    expect(card?.msg.embeds?.[0]?.fields?.at(-1)?.value).toContain("No cross-family bear");
    expect(await t.brain.requestCourt("PLTR", "test")).toMatch(/isn't in the tradeable universe/);
  });

  it("no cross-family bear → the candidate is rejected, never traded single-family", async () => {
    const calls: string[] = [];
    const llm = new LlmRouter({ gemini: provider(bullJson, calls) }, doctrine, () => T0);
    const t = setup({ clef: new ScriptedClef(answers), llm });
    await t.brain.ingestBatch(cryptoBatch);
    t.market.set("BTC/USD", 130, 130.02);
    t.market.news.push(btcNews);
    const r = await t.brain.pulse();
    expect(r.courtContracts).toBe(0);
    expect(
      t.d1.db.prepare("SELECT stage, reason_codes FROM rejections WHERE candidate_id = 'news:77'").get(),
    ).toEqual({
      stage: "BEAR",
      reason_codes: '["no cross-family bear available"]',
    });
  });

  it("a bull brief whose numbers don't fit the evidence is rejected by code", async () => {
    const calls: string[] = [];
    const badBull = bullJson.replace('"stop":126', '"stop":129.4'); // closer than 1.2×ATR
    const llm = new LlmRouter(
      { gemini: provider(badBull, calls), groq: provider(bearJson, calls) },
      doctrine,
      () => T0,
    );
    const t = setup({ clef: new ScriptedClef(answers), llm });
    await t.brain.ingestBatch(cryptoBatch);
    t.market.set("BTC/USD", 130, 130.02);
    t.market.news.push(btcNews);
    await t.brain.pulse();
    expect(calls).toEqual(["gemini-3.5-flash"]); // bear never called
    const rj = t.d1.db
      .prepare("SELECT stage, reason_codes FROM rejections WHERE candidate_id = 'news:77'")
      .get() as {
      stage: string;
      reason_codes: string;
    };
    expect(rj.stage).toBe("BULL");
    expect(rj.reason_codes).toContain("ATR");
  });
});

describe("intake dedupe + courtroom visibility (regressions)", () => {
  it("a dropped headline is not re-queued by the inclusive news cursor", async () => {
    const clef = new FakeClef(() => 0.1); // drop everything
    const t = setup({ clef });
    t.market.news.push({
      id: "9",
      createdAt: T0 - 60_000,
      headline: "Old news",
      summary: "",
      symbols: ["BTCUSD"],
      source: "b",
      url: null,
    });
    const r1 = await t.brain.pulse();
    expect(r1.newsQueued).toBe(1);
    for (let i = 0; i < 3; i++) {
      t.advance(60_000);
      expect((await t.brain.pulse()).newsQueued).toBe(0);
    }
    expect(clef.calls).toHaveLength(1);
  });
});

describe("governor ingest (Phase 4)", () => {
  const gov = (post: boolean) => ({
    schema_version: 1,
    job: "governor",
    produced_at: T0,
    run_url: null,
    items: [
      {
        skill_id: "rejection-ledger-grader",
        version: "gov-v1",
        as_of: T0,
        inputs_sha256: "b".repeat(64),
        payload: {
          grades: [
            { rejection_id: 1, horizon: "24h", graded_at: T0, outcome_r: 1.5, hit: "TARGET" },
            { rejection_id: 1, horizon: "bogus", graded_at: T0, outcome_r: 0, hit: "TARGET" },
            { rejection_id: 999, horizon: "24h", graded_at: T0, outcome_r: 0, hit: "NEITHER" },
          ],
          postmortems: [
            {
              contract_id: "k1",
              account: "PAPER",
              classification: "GOOD_PROCESS_BAD_LUCK",
              realized_r: -1,
              notes: "stop",
            },
          ],
          card: { title: "Governor report", sections: [{ name: "Trades", value: "none" }], post },
        },
      },
    ],
    posture: null,
  });

  it("stores valid grades and postmortems once, skips invalid rows, and posts the card only when asked", async () => {
    const t = setup();
    t.d1.db
      .prepare(
        "INSERT INTO rejections (id, ts, candidate_id, symbol, arena, stage, reason_codes, hypothetical) VALUES (1, 0, 'c', 'BTC/USD', 'CRYPTO', 'VALIDATOR', '[]', '{}')",
      )
      .run();
    const r = await t.brain.ingestBatch(gov(false));
    expect(r.ok).toBe(true);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM rejection_grades").get()).toEqual({ n: 1 });
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM postmortems").get()).toEqual({ n: 1 });
    expect(t.notifier.sent.some((m) => m.channel === "governor")).toBe(false);
    await t.brain.ingestBatch(gov(true));
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM rejection_grades").get()).toEqual({ n: 1 });
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM postmortems").get()).toEqual({ n: 1 });
    expect(t.notifier.sent.filter((m) => m.channel === "governor")).toHaveLength(1);
  });
});

describe("heartbeat stats", () => {
  it("DAY_ROLL reports the previous day's pulses and worst gap", async () => {
    const t = setup();
    await t.brain.pulse();
    t.advance(300_000);
    await t.brain.pulse();
    t.advance(86_400_000);
    await t.brain.pulse();
    const rolls = (
      t.d1.db.prepare("SELECT payload_json FROM journal WHERE kind = 'DAY_ROLL' ORDER BY seq").all() as {
        payload_json: string;
      }[]
    ).map((r) => JSON.parse(r.payload_json));
    expect(rolls).toHaveLength(2);
    expect(rolls[0].pulses).toBeNull();
    expect(rolls[1].pulses).toBe(2);
    expect(rolls[1].max_gap_s).toBe(300);
    expect(rolls[1].equity_cents.PAPER).toBe(5400);
  });
});

describe("options shadow lab ingest (Phase 5)", () => {
  const leg = { symbol: "SPY261204P00700000", side: "short", kind: "put", strike: 700, expiry: "2026-12-04" };
  const ev = (over: Record<string, unknown> = {}) => ({
    trade_id: "OPTIONS_BULL_PUT_SPREAD_V1|SPY|x|2026-10-22",
    kind: "OPEN",
    ts: T0,
    strategy: "OPTIONS_BULL_PUT_SPREAD_V1",
    structure: "vertical_credit",
    underlying: "SPY",
    legs: [leg, { ...leg, symbol: "SPY261204P00692000", side: "long", strike: 692 }],
    cash: 1.5,
    max_loss_cents: 65020,
    max_profit_cents: 14980,
    fees_cents: 20,
    pnl_cents: null,
    r: null,
    reason: null,
    sizer_permits_live: false,
    detail: { dte: 43 },
    ...over,
  });
  const lab = (events: unknown[]) => ({
    schema_version: 1,
    job: "options-lab",
    produced_at: T0,
    run_url: null,
    items: [
      {
        skill_id: "spread-structurer",
        version: "lab-v1",
        as_of: T0,
        inputs_sha256: "c".repeat(64),
        payload: { events, card: { title: "🧪 Options shadow lab", sections: [], post: true } },
      },
    ],
    posture: null,
  });

  it("stores valid virtual events once and rejects disallowed structures or unknown strategies", async () => {
    const t = setup();
    const r = await t.brain.ingestBatch(
      lab([
        ev(),
        ev({ structure: "naked_put" }),
        ev({ strategy: "OPTIONS_MADE_UP_V1" }),
        ev({ strategy: "OPTIONS_PMCC_V1" }), // structure mismatch with the doctrine (diagonal)
      ]),
    );
    expect(r.message).toContain('"open":1');
    expect(r.message).toContain('"rejected":3');
    await t.brain.ingestBatch(lab([ev()]));
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM options_shadow").get()).toEqual({ n: 1 });
    expect(t.notifier.sent.filter((m) => m.channel === "governor")).toHaveLength(1);
    // a virtual trade never becomes a broker order
    expect(t.paper.orders.size).toBe(0);
  });
});

describe("batch dispatcher (ADR-032)", () => {
  it("dispatches a due job once per slot, journals it, and alerts once on failure without blocking the pulse", async () => {
    const calls: string[] = [];
    let fail = false;
    const dispatcher: WorkflowDispatcher = {
      async dispatch(workflow, inputs) {
        if (fail) throw new Error("HTTP 401");
        calls.push(`${workflow}:${JSON.stringify(inputs)}`);
      },
    };
    const t = setup({ dispatcher });
    t.advance(17 * 60_000 + 30_000); // T0 is 12:00 UTC → 12:17:30, just after the hourly world slot
    await t.brain.pulse();
    await t.brain.pulse();
    expect(calls.filter((c) => c.includes('"job":"world"'))).toHaveLength(1);
    const kinds = (
      t.d1.db.prepare("SELECT payload_json FROM journal WHERE kind = 'DISPATCH'").all() as {
        payload_json: string;
      }[]
    ).map((r) => JSON.parse(r.payload_json).job);
    expect(kinds).toContain("world");
    fail = true;
    t.advance(3_600_000);
    const r = await t.brain.pulse();
    expect(r.kill).toBeDefined();
    expect(
      t.notifier.sent.filter((m) => m.msg.content?.includes("batch dispatch failed")).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("memory: scar tissue, reputation, beliefs (ADR-033)", () => {
  it("a merged hard-filter scar vetoes a matching entry before any order", async () => {
    const scar = ScarTissueSchema.parse({
      version: 1,
      rules: [
        {
          id: "SCAR-001",
          kind: "hard_filter",
          rule: "No SOL/USD baseline breakouts (three stops in a row).",
          expression: { all: [{ field: "symbol", op: "==", value: "SOL/USD" }], action: "reject" },
          evidence: ["k1", "k2", "k3"],
          added: "2026-10-22",
        },
      ],
    });
    const t = setup({ scar });
    breakout(t);
    const r = await t.brain.pulse();
    expect(r.entries).toBe(0);
    expect(t.paper.orders.size).toBe(0);
    const rej = t.d1.db.prepare("SELECT stage, reason_codes FROM rejections").all() as {
      stage: string;
      reason_codes: string;
    }[];
    expect(rej.some((x) => x.stage === "SCAR" && x.reason_codes.includes("SCAR-001"))).toBe(true);
  });

  it("entries journal their facts; reputation and beliefs arrive from the Governor", async () => {
    const t = setup();
    breakout(t);
    await t.brain.pulse();
    const facts = t.d1.db.prepare("SELECT payload_json FROM journal WHERE kind = 'ENTRY_FACTS'").get() as {
      payload_json: string;
    };
    expect(JSON.parse(facts.payload_json)).toMatchObject({
      facts: { symbol: "SOL/USD", strategy_id: "CRYPTO_BREAKOUT_BASELINE_V1" },
      reputation_weight: 1,
    });
    const item = (payload: Record<string, unknown>) => ({
      schema_version: 1,
      job: "governor",
      produced_at: T0,
      run_url: null,
      items: [
        {
          skill_id: "source-reputation",
          version: "gov-v1",
          as_of: T0,
          inputs_sha256: "d".repeat(64),
          payload,
        },
      ],
      posture: null,
    });
    await t.brain.ingestBatch(
      item({
        reputation: [
          { source: "news:benzinga", signals: 25, brier_30d: null, expectancy_r_30d: 0.4, weight: 1.1 },
          { source: "filing", signals: 5, brier_30d: null, expectancy_r_30d: -1, weight: 0.6 },
        ],
        beliefs: [
          {
            belief_id: "sym:SOL/USD",
            subject: "SOL/USD",
            tags: ["CRYPTO"],
            statement: "SOL/USD: 4 closed trades, E[R] +0.60 over 30 days.",
            c0: 0.5,
            half_life_days: 60,
            validated_at: T0,
            validations: 1,
            status: "ACTIVE",
            evidence: ["k1"],
          },
        ],
      }),
    );
    expect(t.brain.reputationWeight("news:benzinga")).toBe(1.1);
    expect(t.brain.reputationWeight("filing")).toBe(1); // below min_signals_before_adjusting
    expect(t.brain.reputationWeight(null)).toBe(1);
    expect(t.sql.exec("SELECT belief_id FROM beliefs")).toHaveLength(1);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM beliefs").get()).toEqual({ n: 1 });
  });
});

describe("cockpit (Phase 6)", () => {
  it("samples equity hourly and charts it on the HUD", async () => {
    const t = setup();
    await t.brain.pulse();
    t.advance(3_600_000);
    await t.brain.pulse();
    const s = t.brain.status();
    expect(s.equity.PAPER?.length).toBe(2);
    expect(equityChartUrl(s.equity.PAPER)).toMatch(/^https:\/\/quickchart\.io\/chart\?/);
    expect(equityChartUrl([[1, 2]])).toBeNull();
  });

  it("streams notable journal events to #agent-terminal once per pulse", async () => {
    const t = setup();
    breakout(t);
    await t.brain.pulse();
    const term = t.notifier.sent.filter((m) => m.channel === "terminal");
    expect(term).toHaveLength(1);
    expect(term[0]?.msg.content).toContain("ENTRY_FACTS");
    expect(
      terminalLine({ ts: 0, account: "SYSTEM", kind: "PULSE", refId: null, payloadJson: "{}" }),
    ).toBeNull();
  });

  it("login nonces are single use", () => {
    const t = setup();
    expect(t.brain.consumeOnce("login:n1")).toBe(true);
    expect(t.brain.consumeOnce("login:n1")).toBe(false);
  });
});

describe("entry guards (ADR-035)", () => {
  const eq = (symbol: string, id: string): DecisionContract => ({
    contract_id: id,
    created_at: T0,
    schema_version: 1 as const,
    origin: "RULE" as const,
    symbol,
    arena: "EQUITIES" as const,
    strategy_id: "EQUITY_CATALYST_COURT_V1",
    thesis_summary: `${symbol} test contract for the earnings blackout guard.`,
    bull_case_receipts: [{ evidence_id: "x", source_skill: "t", metric: "m", metric_value: 1, as_of: T0 }],
    bear_case_brief: "Test: earnings within 72 hours must block the entry.",
    kill_criteria: ["stop hit"],
    invalidation_criteria: { stop_price: "96", max_hold_hours: 72 },
    entry_plan: { zone_low: "99", zone_high: "101", urgency: "NORMAL" as const, targets: ["112"] },
    clef_probabilities: null,
    win_prob_used: 0.6,
    bear_lethality: 0,
    atr: 2,
    cost_and_fee_drag: { entry_fee_bps: 0, exit_fee_bps: 1, expected_slippage_bps: 5, cognitive_cost_usd: 0 },
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
  const reasons = (t: ReturnType<typeof setup>) =>
    (t.d1.db.prepare("SELECT reason_codes FROM rejections").all() as { reason_codes: string }[])
      .map((r) => r.reason_codes)
      .join(" ");

  it("blocks equity entries when the calendar is stale, and inside the earnings window", async () => {
    const t = setup();
    await t.brain.pulse();
    t.market.set("AAPL", 100, 100.02);
    const k = eq("AAPL", "01930f4e-7b2a-7c3d-8e4f-5a6b7c8d9e01");
    t.brain.recordContract(k, T0);
    expect(await t.brain.executeEntry("PAPER", k, { bid: 100, ask: 100.02, at: T0 })).toBe(false);
    await t.brain.flushJournal();
    expect(reasons(t)).toContain("earnings calendar stale");
    const tomorrow = new Date(T0 + 86_400_000).toISOString().slice(0, 10);
    const r = await t.brain.ingestBatch({
      schema_version: 1,
      job: "equity-posture",
      produced_at: T0,
      run_url: null,
      items: [
        {
          skill_id: "earnings-calendar",
          version: "fmp",
          as_of: T0,
          inputs_sha256: "e".repeat(64),
          payload: { events: [{ symbol: "AAPL", date: tomorrow }] },
        },
      ],
      posture: {
        arena: "EQUITIES",
        posture: "NEW_ENTRY_ALLOWED",
        score: 60,
        ceiling: 0.6,
        confidence: null,
        summary: "ok",
      },
    });
    expect(r.ok).toBe(true);
    const k2 = eq("AAPL", "01930f4e-7b2a-7c3d-8e4f-5a6b7c8d9e02");
    t.brain.recordContract(k2, T0);
    expect(await t.brain.executeEntry("PAPER", k2, { bid: 100, ask: 100.02, at: T0 })).toBe(false);
    await t.brain.flushJournal();
    expect(reasons(t)).toContain(`earnings on ${tomorrow}`);
  });
});

describe("setup screeners (ADR-035)", () => {
  const batch = (producedAt: number, score = 74) => ({
    schema_version: 1,
    job: "screeners",
    produced_at: producedAt,
    run_url: null,
    items: [
      {
        skill_id: "setup-screeners",
        version: "x",
        as_of: producedAt,
        inputs_sha256: "f".repeat(64),
        payload: {
          candidates: [
            {
              id: "stockbee-momentum-burst-screener:SOL/USD:2026-10-21",
              screener: "stockbee-momentum-burst-screener",
              symbol: "SOL/USD",
              bar_date: "2026-10-21",
              score,
              state: "ACTIONABLE_DAY1",
              headline: "SOL/USD: momentum burst setup",
              entry_reference: 100,
              stop_reference: 95,
              as_of: producedAt,
            },
          ],
        },
      },
    ],
    posture: null,
  });

  it("queues hits straight to Tier 2 once, keyed for reputation by screener", async () => {
    const t = setup();
    expect((await t.brain.ingestBatch(batch(T0))).message).toContain("queued 1");
    expect((await t.brain.ingestBatch(batch(T0))).message).toContain("queued 0");
    const row = t.sql.exec<{ tier: number; payload_json: string }>(
      "SELECT tier, payload_json FROM triage_queue",
    )[0];
    expect(row?.tier).toBe(2);
    expect(JSON.parse(row?.payload_json ?? "{}").kind).toBe("screener:momentum-burst");
  });

  it("refuses stale batches", async () => {
    const t = setup();
    t.advance(31 * 3_600_000);
    expect((await t.brain.ingestBatch(batch(T0))).ok).toBe(false);
  });
});

describe("fresh start (ADR-038)", () => {
  it("refuses while the broker holds a position, then resets a flat account", async () => {
    const t = setup();
    await t.brain.pulse();
    t.paper.positionsBySymbol.set("ETH/USD", { qty: 0.001, avg: 3000 });
    const refused = await t.brain.resetAccount("PAPER", "test");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("not flat");
    t.paper.positionsBySymbol.delete("ETH/USD");
    t.sql.exec("UPDATE accounts SET hwm_cents = 9999, breaker = 'YELLOW' WHERE account = 'PAPER'");
    const r = await t.brain.resetAccount("PAPER", "test");
    expect(r.ok).toBe(true);
    const row = t.sql.exec<{ hwm_cents: number | null; breaker: string }>(
      "SELECT hwm_cents, breaker FROM accounts WHERE account = 'PAPER'",
    )[0];
    expect(row?.hwm_cents).toBeNull();
    expect(row?.breaker).toBe("GREEN");
    expect(t.sql.exec("SELECT * FROM cursors WHERE name = 'activities:PAPER'")).toHaveLength(0);
    expect(t.d1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'RESET'").get()).toEqual({ n: 1 });
    expect(
      t.notifier.sent.some(
        (m) => m.channel === "alarms" && m.msg.content?.includes("reset to a fresh start"),
      ),
    ).toBe(true);
    // the next pulse re-baselines the activity cursor and works normally
    const p = await t.brain.pulse();
    expect(p.accounts.PAPER?.ok).toBe(true);
  });
});

describe("exception lane (ADR-039)", () => {
  const news = (id: string) => ({
    id,
    createdAt: T0 - 5 * 60_000,
    headline: `Headline ${id}`,
    summary: "s",
    symbols: ["BTCUSD"],
    source: "benzinga",
    url: null,
  });
  const cryptoBatch = (score: number) => ({
    schema_version: 1,
    job: "crypto-regime",
    produced_at: T0,
    run_url: null,
    items: [
      {
        skill_id: "crypto-regime-analyzer",
        version: "x",
        as_of: T0,
        inputs_sha256: "a".repeat(64),
        payload: { composite: { score } },
      },
    ],
    posture: {
      arena: "CRYPTO",
      posture: "REDUCE_ONLY",
      score,
      ceiling: null,
      confidence: null,
      summary: "weak",
    },
  });
  const stage = (t: ReturnType<typeof setup>, id: string) =>
    t.d1.db
      .prepare("SELECT stage, reason_codes, hypothetical FROM rejections WHERE candidate_id = ?")
      .get(id) as { stage: string; reason_codes: string; hypothetical: string } | undefined;

  it("lets an exceptional catalyst through a closed crypto gate to Tier 2; ordinary ones are refused but gradeable", async () => {
    const clef = new FakeClef(
      (h) => (h === "Headline 1" ? 0.92 : 0.6),
      (h) => (h === "Headline 1" ? 2.6 : 1.4),
    );
    const t = setup({ clef });
    t.market.set("BTC/USD", 100, 100.02);
    expect((await t.brain.ingestBatch(cryptoBatch(30))).ok).toBe(true);
    t.market.news.push(news("1"));
    await t.brain.pulse();
    await t.brain.flushJournal();
    // exceptional: not refused at Tier 0, went on to Clef 27B (this Tier 1 fake can't answer Tier 2 itself)
    expect(clef.calls.some((c) => c.model === "clef")).toBe(true);
    expect(stage(t, "news:1")?.stage).not.toBe("TIER0");
    // ordinary (promoted by Tier 1 but not exceptional): refused at Tier 0 with a gradeable bid/ATR hypothetical
    const u = setup({
      clef: new FakeClef(
        () => 0.6,
        () => 1.4,
      ),
    });
    u.market.set("BTC/USD", 100, 100.02);
    await u.brain.ingestBatch(cryptoBatch(30));
    u.market.news.push(news("2"));
    await u.brain.pulse();
    await u.brain.flushJournal();
    const r2 = stage(u, "news:2");
    expect(r2?.stage).toBe("TIER0");
    expect(r2?.reason_codes).toContain("crypto regime gate closed (score 30)");
    expect(JSON.parse(r2?.hypothetical ?? "{}")).toMatchObject({ bid: 100, gate: true });
  });

  it("never opens below the crypto floor or on stale data", async () => {
    const clef = new FakeClef(
      () => 0.95,
      () => 2.9,
    );
    const t = setup({ clef });
    t.market.set("BTC/USD", 100, 100.02);
    await t.brain.ingestBatch(cryptoBatch(20));
    t.market.news.push(news("1"));
    await t.brain.pulse();
    await t.brain.flushJournal();
    expect(stage(t, "news:1")?.reason_codes).toContain("score 20");
    const t2 = setup({
      clef: new FakeClef(
        () => 0.95,
        () => 2.9,
      ),
    });
    t2.market.set("BTC/USD", 100, 100.02);
    t2.market.news.push(news("9"));
    await t2.brain.pulse();
    await t2.brain.flushJournal();
    expect(stage(t2, "news:9")?.reason_codes).toContain("stale");
  });
});

describe("Falling-market strategies (ADR-040)", () => {
  const slide = (n: number, from: number, to: number): Bar[] =>
    Array.from({ length: n }, (_, i) => {
      const c = from + ((to - from) * i) / (n - 1);
      return { t: T0 - (n - i) * 86_400_000, o: c, h: c + 1, l: c - 1, c, v: 1 };
    });

  it("oversold bounce → RULE contract → passive PAPER buy, even with the risk-on gate closed", async () => {
    const t = setup();
    t.market.bars["BTC/USD"] = slide(30, 130, 100); // BTC under its EMA: breakout baseline stays off
    t.market.bars["ETH/USD"] = slide(25, 130, 100);
    t.market.set("ETH/USD", 102, 102.02); // back above yesterday's high (101)
    const r = await t.brain.pulse();
    expect(r.contracts).toBe(1);
    expect(r.entries).toBe(1);
    const k = t.d1.db.prepare("SELECT strategy_id, symbol FROM decision_contracts").get();
    expect(k).toEqual({ strategy_id: "CRYPTO_OVERSOLD_BOUNCE_V1", symbol: "ETH/USD" });
    const entry = [...t.paper.orders.values()][0];
    expect(entry?.side).toBe("buy");
    expect(Number(entry?.qty) * 102).toBeLessThanOrEqual(54 * 0.35);
    // once per symbol per day, hourly cadence
    t.advance(2 * HOUR);
    expect((await t.brain.pulse()).contracts).toBe(0);
  });

  it("inverse ETF breakout buys only in a bearish equity posture, during the session", async () => {
    const t = setup();
    t.market.bars.SH = slide(30, 36, 40);
    t.market.set("SH", 41.6, 41.61);
    t.sql.exec(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('earnings_as_of', ?, ?)",
      String(T0),
      T0,
    );
    const posture = (p: string, at: number) =>
      t.sql.exec(
        "INSERT OR REPLACE INTO regime_state (arena, posture, score, ceiling, payload_json, as_of) VALUES ('EQUITIES', ?, NULL, NULL, '{}', ?)",
        p,
        at,
      );
    posture("NEW_ENTRY_ALLOWED", T0);
    expect((await t.brain.pulse()).contracts).toBe(0); // bullish market: no hedge
    t.advance(2 * HOUR);
    posture("REDUCE_ONLY", T0 + 2 * HOUR);
    t.paper.isOpen = false;
    expect((await t.brain.pulse()).contracts).toBe(0); // market closed: the hourly slot is not spent
    t.paper.isOpen = true;
    const r = await t.brain.pulse();
    expect(r.contracts).toBe(1);
    expect(r.entries).toBe(1);
    const k = t.d1.db.prepare("SELECT strategy_id, symbol FROM decision_contracts").get();
    expect(k).toEqual({ strategy_id: "EQUITY_INVERSE_BREAKOUT_V1", symbol: "SH" });
  });
});
