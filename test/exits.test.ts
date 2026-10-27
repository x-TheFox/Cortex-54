import { describe, expect, it } from "vitest";
import type { ClefApi, ClefQuestion, ClefResult } from "../src/clef/ClefClient.ts";
import type { Doctrine } from "../src/contracts/doctrine.ts";
import { Brain } from "../src/cortex/Brain.ts";
import type { WorkflowDispatcher } from "../src/cortex/dispatch.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { labDoctrine } from "../src/cortex/lab.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import type { AccountId } from "../src/lib/ids.ts";
import {
  type ExitState,
  holdOrHarvest,
  interpretReview,
  ratchetStop,
  rMultiple,
  stagnant,
  tightenedStop,
  tripwires,
} from "../src/portfolio/exits.ts";
import type { Bar } from "../src/strategy/indicators.ts";
import { constitution, doctrine, doctrineWith } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;
const cfg = doctrine.exits;

const st = (over: Partial<ExitState> = {}): ExitState => ({
  entry: 100,
  initialStop: 96,
  stop: 96,
  target: 106,
  atr: 2,
  feeRt: 0.005,
  openedAt: T0,
  maxHoldUntil: T0 + 48 * HOUR,
  mfe: 100,
  mae: 100,
  trailing: false,
  ...over,
});

describe("exit rules (pure, ADR-059)", () => {
  it("breakeven at +1R, then a chandelier trail at +1.5R; never down, never at the bid", () => {
    expect(ratchetStop(st(), 103, cfg, false)).toBeNull(); // +0.75R: nothing yet
    const be = ratchetStop(st(), 104, cfg, false); // entry + fees
    expect(be?.why).toBe("BREAKEVEN");
    expect(be?.stop).toBeCloseTo(100.5, 9);
    const trail = ratchetStop(st({ stop: 100.5, mfe: 107 }), 106.5, cfg, false);
    expect(trail?.why).toBe("TRAIL");
    expect(trail?.stop).toBeCloseTo(107 - 1.2 * 2, 6); // best − 1.2 ATR
    expect(ratchetStop(st({ stop: 100.5, mfe: 107 }), 106.5, cfg, true)?.stop).toBeCloseTo(107 - 0.8 * 2, 6);
    expect(ratchetStop(st({ stop: 105 }), 106, cfg, false)).toBeNull(); // breakeven is below the current stop
    expect(ratchetStop(st({ mfe: 104 }), 100.4, cfg, false)).toBeNull(); // breakeven ≥ bid → would fire at once
    expect(ratchetStop(st(), 104, { ...cfg, enabled: false }, false)).toBeNull();
  });

  it("hold-or-harvest needs every momentum check; unknown means harvest", () => {
    const ok = { regimeOpen: true, aboveEma20: true, rsi14: 62, kronosPUp: 0.6 };
    expect(holdOrHarvest(cfg, ok).action).toBe("TRAIL");
    expect(holdOrHarvest(cfg, { ...ok, regimeOpen: false }).action).toBe("HARVEST");
    expect(holdOrHarvest(cfg, { ...ok, aboveEma20: null }).action).toBe("HARVEST");
    expect(holdOrHarvest(cfg, { ...ok, rsi14: 85 }).why).toMatch(/exhausted/);
    expect(holdOrHarvest(cfg, { ...ok, kronosPUp: 0.4 }).action).toBe("HARVEST");
    expect(holdOrHarvest(cfg, { ...ok, kronosPUp: null }).action).toBe("TRAIL");
  });

  it("stagnation: half the horizon gone and still within ±0.25R", () => {
    expect(stagnant(st(), 100.5, T0 + 30 * HOUR, cfg)).toBe(true);
    expect(stagnant(st(), 100.5, T0 + 10 * HOUR, cfg)).toBe(false);
    expect(stagnant(st(), 103, T0 + 30 * HOUR, cfg)).toBe(false);
  });

  it("tripwires: regime flip, Kronos 10% band at the right step, funding, thesis, headline", () => {
    const base = {
      arena: "CRYPTO",
      regimeOpenNow: true,
      regimeOpenAtEntry: true,
      kronos: null,
      fundingMultiplier: 1,
      thesis: null,
      materialHeadline: null,
      bid: 100,
      now: T0 + 9 * HOUR,
    };
    expect(tripwires(base)).toEqual([]);
    expect(tripwires({ ...base, regimeOpenNow: false })).toEqual(["CRYPTO regime closed since entry"]);
    // 4 h candles, 9 h after the forecast → step 2 (band 99)
    const k = { p10: [101, 100, 99, 98], produced_at: T0, candle_hours: 4 };
    expect(tripwires({ ...base, kronos: k, bid: 99.5 })).toEqual([]);
    expect(tripwires({ ...base, kronos: k, bid: 98.9 })[0]).toBe("price below the Kronos 10% band");
    expect(tripwires({ ...base, kronos: k, bid: 99.5 })).toEqual([]); // step 2's band is 99
    expect(
      tripwires({ ...base, thesis: "BROKEN", fundingMultiplier: 0.5, materialHeadline: "⬇ SEC sues" }),
    ).toEqual(["perp funding crowded", "watch dossier: thesis BROKEN", "headline: ⬇ SEC sues"]);
  });

  it("review rulings: kill or confident exit → EXIT; weaker → TIGHTEN; missing → HOLD", () => {
    const res = (alive: number, kill: number, act: string, probs: Record<string, number>): ClefResult => ({
      model: "clef",
      answers: {
        thesis_alive: { type: "noul", noul: alive },
        kill_fired: { type: "noul", noul: kill },
        action: { type: "choice", choice: act, probabilities: probs },
      },
      usage: { input_tokens: 1 },
    });
    expect(interpretReview(res(0.6, 0.8, "HOLD", { HOLD: 0.6 }), cfg).action).toBe("EXIT");
    expect(interpretReview(res(0.4, 0.2, "EXIT", { EXIT: 0.65, HOLD: 0.35 }), cfg).action).toBe("EXIT");
    expect(interpretReview(res(0.5, 0.2, "EXIT", { EXIT: 0.55, HOLD: 0.45 }), cfg).action).toBe("TIGHTEN");
    expect(interpretReview(res(0.3, 0.1, "HOLD", { HOLD: 0.9 }), cfg).action).toBe("TIGHTEN");
    expect(interpretReview(res(0.8, 0.1, "HOLD", { HOLD: 0.9 }), cfg).action).toBe("HOLD");
    expect(interpretReview({ model: "clef", answers: {}, usage: { input_tokens: 1 } }, cfg).action).toBe(
      "HOLD",
    );
    expect(tightenedStop(st({ stop: 96 }), 103)).toBe(102);
    expect(tightenedStop(st({ stop: 102.6 }), 103)).toBeNull();
  });

  it("R multiples are measured against the initial stop, not the ratcheted one", () => {
    expect(rMultiple(st({ stop: 100.5 }), 104)).toBe(1);
  });

  it("LAB keeps plain exits and no wire intake (clean forward tests)", () => {
    const lab = labDoctrine(doctrine);
    expect(lab.exits.enabled).toBe(false);
    expect(lab.universe.enabled).toBe(false);
  });
});

// ------------------------------------------------------------------ simulated pulses

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
/** a healthy uptrend: net up, RSI ≈ 60 (not exhausted) */
function trending(n: number, start: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + 0.3 * i + (i % 2 === 0 ? 0.8 : -0.8);
    return { t: T0 - (n - i) * 86_400_000, o: c, h: c + 1, l: c - 1, c, v: 1 };
  });
}

class ReviewClef implements ClefApi {
  calls = 0;
  constructor(private readonly action: string) {}
  async run(
    model: "clef-flash" | "clef",
    state: unknown,
    q: Record<string, ClefQuestion>,
  ): Promise<ClefResult> {
    this.calls++;
    const answers: ClefResult["answers"] = {};
    if ("thesis_alive" in q) {
      answers.thesis_alive = { type: "noul", noul: this.action === "EXIT" ? 0.2 : 0.8 };
      answers.kill_fired = { type: "noul", noul: this.action === "EXIT" ? 0.85 : 0.1 };
      answers.action = { type: "choice", choice: this.action, probabilities: { [this.action]: 0.9 } };
    } else {
      // Tier 1 (items i0…): material headline about a held symbol, not promoted
      for (const id of Object.keys(q)) {
        if (id.endsWith("material")) answers[id] = { type: "noul", noul: 0.7 };
        if (id.endsWith("direction"))
          answers[id] = {
            type: "choice",
            choice: "down",
            probabilities: { up: 0.1, down: 0.8, unclear: 0.1 },
          };
        if (id.endsWith("escalate")) answers[id] = { type: "score", score: 0.5 };
      }
    }
    void state;
    return { model, answers, usage: { input_tokens: 800, output_tokens: 0 } };
  }
}

function setup(opts: { d?: Doctrine; clef?: ClefApi; dispatcher?: WorkflowDispatcher } = {}) {
  let now = T0;
  const clock = () => now;
  const market = new Market(clock);
  market.bars["BTC/USD"] = rising(30, 100);
  market.bars["SOL/USD"] = flat(30, 100);
  market.set("SOL/USD", 100, 100.02);
  const paper = new FakeBroker(market, 54, clock);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const d1 = memoryD1();
  const notifier = new NullNotifier();
  const brokers: Partial<Record<AccountId, FakeBroker>> = { PAPER: paper };
  const brain = new Brain({
    sql,
    d: opts.d ?? doctrine,
    c: constitution,
    brokers,
    market: new FakeMarketData(market),
    notifier,
    d1,
    readKillFlag: async () => false,
    now: clock,
    clef: opts.clef ?? null,
    dispatcher: opts.dispatcher ?? null,
  });
  brain.init({ test: true });
  const t = {
    brain,
    sql,
    d1,
    market,
    paper,
    notifier,
    advance(ms: number) {
      now += ms;
      market.touch();
    },
    /** baseline breakout on SOL: entry 102, stop 98 (R = 4), target ≈ 108 */
    async open() {
      market.set("SOL/USD", 102, 102.02);
      await brain.pulse();
      t.advance(60_000);
      market.set("SOL/USD", 101.99, 102);
      paper.tick();
      await brain.pulse();
    },
  };
  return t;
}

const events = (t: ReturnType<typeof setup>, kind: string) =>
  (
    t.d1.db.prepare("SELECT payload_json FROM journal WHERE kind = ? ORDER BY seq").all(kind) as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json));

const freshCrypto = (t: ReturnType<typeof setup>, at: number) =>
  t.brain.ingestBatch({
    schema_version: 1,
    job: "crypto-regime",
    produced_at: at,
    run_url: null,
    items: [
      {
        skill_id: "crypto-regime-analyzer",
        version: "x",
        as_of: at,
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
  });

describe("exit engine in the pulse (ADR-059)", () => {
  it("+1R moves the stop to breakeven and replaces the broker stop", async () => {
    const t = setup();
    await t.open();
    const pos = () => t.sql.exec<{ stop_price: string }>("SELECT stop_price FROM positions")[0];
    expect(Number(pos()?.stop_price)).toBeCloseTo(98, 2);
    t.advance(60_000);
    t.market.set("SOL/USD", 106.1, 106.12); // +1.0R
    await t.brain.pulse();
    await t.brain.flushJournal();
    const be = Number(pos()?.stop_price);
    expect(be).toBeGreaterThan(102);
    expect(be).toBeLessThan(103);
    // the old stop is cancelled first; the replacement goes in once the broker confirms the cancel (next pulse)
    expect([...t.paper.orders.values()].filter((o) => o.type === "stop_limit").map((o) => o.status)).toEqual([
      "canceled",
    ]);
    t.advance(60_000);
    await t.brain.pulse();
    const stops = [...t.paper.orders.values()].filter((o) => o.type === "stop_limit");
    expect(stops.map((o) => o.status)).toEqual(["canceled", "new"]);
    expect(Number(stops[1]?.stop_price)).toBeCloseTo(be, 2);
    expect(events(t, "STOP_MOVE")[0]).toMatchObject({ symbol: "SOL/USD", why: "BREAKEVEN" });
  });

  it("small trail steps move only the synthetic stop; the broker stop follows in ≥ 0.25 ATR steps", async () => {
    const t = setup({ d: doctrineWith((x) => (x.exits.trail_after_r = 1.0)) });
    await t.open();
    t.advance(60_000);
    t.market.set("SOL/USD", 107.0, 107.02); // +1.25R, under the target → chandelier 107 − 1.2 ATR
    await t.brain.pulse();
    t.advance(60_000);
    await t.brain.pulse(); // replacement stop placed after the cancel is confirmed
    const brokerStops = () =>
      [...t.paper.orders.values()].filter((o) => o.type === "stop_limit" && o.status === "new");
    const before = brokerStops().map((o) => o.stop_price);
    t.advance(60_000);
    t.market.set("SOL/USD", 107.2, 107.22); // a tiny new high: trail rises 0.2, under 0.25 ATR (0.5)
    await t.brain.pulse();
    expect(brokerStops().map((o) => o.stop_price)).toEqual(before);
    const synthetic = Number(
      t.sql.exec<{ stop_price: string }>("SELECT stop_price FROM positions")[0]?.stop_price,
    );
    expect(synthetic).toBeGreaterThan(Number(before[0]));
  });

  it("at the target with momentum intact it trails instead of selling, then exits on the trail", async () => {
    const t = setup();
    await t.open();
    await freshCrypto(t, T0);
    t.market.bars["SOL/USD"] = trending(40, 95);
    t.advance(60_000);
    t.market.set("SOL/USD", 108.6, 108.62); // at/above the target
    const r = await t.brain.pulse();
    expect(r.exits).toBe(0);
    await t.brain.flushJournal();
    expect(events(t, "HARVEST_TRAIL")).toHaveLength(1);
    const trailStop = Number(
      t.sql.exec<{ stop_price: string }>("SELECT stop_price FROM positions")[0]?.stop_price,
    );
    expect(trailStop).toBeGreaterThan(104);
    t.advance(60_000);
    t.market.set("SOL/USD", 110, 110.02); // runs further: the trail follows
    await t.brain.pulse();
    const higher = Number(
      t.sql.exec<{ stop_price: string }>("SELECT stop_price FROM positions")[0]?.stop_price,
    );
    expect(higher).toBeGreaterThan(trailStop);
    t.advance(60_000);
    t.market.set("SOL/USD", higher - 0.5, higher - 0.48); // gives back past the trail
    t.paper.tick();
    await t.brain.pulse();
    t.advance(60_000);
    t.paper.tick();
    await t.brain.pulse();
    await t.brain.flushJournal();
    expect(t.sql.exec("SELECT * FROM positions")).toHaveLength(0);
    const ex = events(t, "EXCURSIONS")[0];
    expect(ex.trailed).toBe(true);
    expect(ex.mfe_r).toBeGreaterThan(1.9);
    const exit = t.sql.exec<{ pnl_cents: number }>("SELECT pnl_cents FROM exits")[0];
    expect(exit?.pnl_cents).toBeGreaterThan(0);
  });

  it("without a fresh regime the target is harvested as before", async () => {
    const t = setup();
    await t.open();
    t.advance(60_000);
    t.market.set("SOL/USD", 108.6, 108.62);
    expect((await t.brain.pulse()).exits).toBe(1);
  });

  it("a material bearish headline about a held symbol triggers a review; EXIT starts the sale", async () => {
    const clef = new ReviewClef("EXIT");
    const t = setup({ clef });
    await t.open();
    t.market.news.push({
      id: "h1",
      createdAt: T0 + 3 * 60_000,
      headline: "Solana outage halts block production for hours",
      summary: "",
      symbols: ["SOLUSD"],
      source: "benzinga",
      url: null,
    });
    t.advance(2 * 60_000);
    await t.brain.pulse();
    await t.brain.flushJournal();
    const rev = events(t, "REVIEW")[0];
    expect(rev).toMatchObject({ symbol: "SOL/USD", action: "EXIT" });
    expect(rev.tripwires[0]).toMatch(/^headline: ⬇ Solana outage/);
    expect(
      t.sql.exec<{ state: string; exit_reason: string }>("SELECT state, exit_reason FROM positions")[0],
    ).toEqual({
      state: "EXITING",
      exit_reason: "REVIEW_EXIT",
    });
    // the same tripwire never triggers a second hearing
    t.advance(60_000);
    await t.brain.pulse();
    await t.brain.flushJournal();
    expect(events(t, "REVIEW")).toHaveLength(1);
  });

  it("a HOLD ruling changes nothing; a TIGHTEN ruling raises the stop in code", async () => {
    const t = setup({ clef: new ReviewClef("TIGHTEN") });
    await t.open();
    t.sql.exec(
      "UPDATE position_watch SET pending_headline = 'Solana fee market change' WHERE symbol = 'SOL/USD'",
    );
    t.advance(60_000);
    t.market.set("SOL/USD", 103, 103.02);
    await t.brain.pulse();
    const stop = Number(
      t.sql.exec<{ stop_price: string }>("SELECT stop_price FROM positions")[0]?.stop_price,
    );
    expect(stop).toBeCloseTo(103 - 0.5 * 2, 1); // half an ATR under the bid (contract ATR ≈ 2)
  });

  it("dispatches a daily watch dossier with the bear's kill criteria once a position is 2 h old", async () => {
    const sent: Record<string, string>[] = [];
    const t = setup({ dispatcher: { dispatch: async (_w, inputs) => void sent.push(inputs) } });
    await t.open();
    await t.brain.pulse();
    expect(sent.filter((s) => s.mode === "watch")).toHaveLength(0);
    t.advance(2 * HOUR + 60_000);
    await t.brain.pulse();
    t.advance(60_000);
    await t.brain.pulse();
    const w = sent.filter((s) => s.mode === "watch");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ job: "dossier", symbol: "SOL/USD", arena: "CRYPTO", depth: "quick" });
    expect(w[0]?.kill?.length).toBeGreaterThan(0);
  });

  it("equities are sold before earnings inside the blackout", async () => {
    const d = doctrineWith((x) => {
      x.exits.earnings_derisk = true;
    });
    const t = setup({ d });
    // a held equity position (adopted directly into hot state)
    t.sql.exec(
      `INSERT INTO positions (account, symbol, arena, contract_id, qty, avg_entry, stop_price, target_price, fee_rt,
         opened_at, max_hold_until, state) VALUES ('PAPER', 'AAPL', 'EQUITIES', 'k1', '0.05', '200', '195', '210', 0.001, ?, ?, 'OPEN')`,
      T0,
      T0 + 72 * HOUR,
    );
    t.paper.positionsBySymbol.set("AAPL", { qty: 0.05, avg: 200 });
    t.market.set("AAPL", 201, 201.05);
    t.sql.exec("INSERT INTO earnings (symbol, date) VALUES ('AAPL', '2026-10-23')");
    await t.brain.pulse();
    expect(t.sql.exec<{ exit_reason: string }>("SELECT exit_reason FROM positions")[0]?.exit_reason).toBe(
      "EARNINGS_DERISK",
    );
  });
});
