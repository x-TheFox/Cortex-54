import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type HubDb, handleHub, LIMITS } from "../hub/src/handler.ts";
import { applyPack, exportPack, loadLocalScar, stagePack } from "../local/memory.ts";
import { Brain } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { NullNotifier } from "../src/discord/notifier.ts";
import { hubFromEnv } from "../src/hub/client.ts";
import {
  agentIdOf,
  canonical,
  type FeedRow,
  generateAgentKey,
  publicKeyOf,
  rowIsConsistent,
  signPayload,
  verifyPayload,
} from "../src/hub/protocol.ts";
import { rowHash } from "../src/journal/Journal.ts";
import { constitution, doctrine } from "./helpers.ts";
import { FakeBroker, FakeMarketData, Market } from "./sim/FakeBroker.ts";
import { memoryD1, memorySql } from "./sim/sqlite.ts";

function hubDb(): HubDb & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("hub/migrations/0001_hub.sql", "utf8"));
  db.exec(readFileSync("hub/migrations/0002_quotas.sql", "utf8"));
  return {
    db,
    all: async <T>(q: string, ...b: unknown[]) => db.prepare(q).all(...(b as never[])) as T[],
    first: async <T>(q: string, ...b: unknown[]) =>
      (db.prepare(q).get(...(b as never[])) as T | undefined) ?? null,
    run: async (q: string, ...b: unknown[]) => void db.prepare(q).run(...(b as never[])),
  };
}

const call = (db: HubDb, now: number) => async (url: string, init?: RequestInit) =>
  handleHub(new Request(url.startsWith("http") ? url : `https://hub.test${url}`, init), db, now);

function chain(n: number, start = 0, prev = "0".repeat(64), t0 = 1_000): FeedRow[] {
  const rows: FeedRow[] = [];
  for (let i = 1; i <= n; i++) {
    const seq = start + i;
    const payload = JSON.stringify({ symbol: "BTC/USD", pnl_cents: i % 2 ? 40 : -20 });
    const sha = rowHash(prev, seq, t0 + seq, "EXIT", payload);
    rows.push({
      seq,
      ts: t0 + seq,
      account: "PAPER",
      kind: "EXIT",
      ref_id: null,
      payload_json: payload,
      prev_row_sha256: prev,
      row_sha256: sha,
    });
    prev = sha;
  }
  return rows;
}

async function batch(
  key: { privateKey: string; publicKey: string },
  rows: FeedRow[],
  now: number,
  name = "alpha",
) {
  const head = { seq: rows.at(-1)?.seq ?? 0, sha: rows.at(-1)?.row_sha256 ?? "0".repeat(64) };
  const body = { v: 1 as const, public_key: key.publicKey, name, sent_at: now, head, rows };
  return canonical({ ...body, sig: await signPayload(key.privateKey, body) });
}

describe("hub protocol (ADR-068)", () => {
  it("Ed25519 keys, ids, canonical signing", async () => {
    const k = await generateAgentKey();
    expect(k.agentId).toMatch(/^[0-9a-f]{16}$/);
    expect(await publicKeyOf(k.privateKey)).toBe(k.publicKey);
    expect(agentIdOf(k.publicKey)).toBe(k.agentId);
    const sig = await signPayload(k.privateKey, { b: 1, a: [2, { d: 1, c: 2 }] });
    expect(await verifyPayload(k.publicKey, { a: [2, { c: 2, d: 1 }], b: 1 }, sig)).toBe(true); // key order irrelevant
    expect(await verifyPayload(k.publicKey, { a: [2, { c: 2, d: 1 }], b: 2 }, sig)).toBe(false);
    expect(chain(3).every(rowIsConsistent)).toBe(true);
  });
});

describe("hub API (ADR-068)", () => {
  it("accepts a signed, hash-consistent feed; rejects bad signatures, tampered rows, rewrites and replays", async () => {
    const db = hubDb();
    const now = 5_000_000;
    const h = call(db, now);
    const k = await generateAgentKey();
    const rows = chain(6);
    const ok = await h("/v1/feed", { method: "POST", body: await batch(k, rows, now) });
    expect(await ok.json()).toMatchObject({ ok: true, agent_id: k.agentId, stored: 6 });
    // someone else's key can't publish as this agent
    const other = await generateAgentKey();
    const forged = JSON.parse(await batch(other, rows, now));
    forged.public_key = k.publicKey;
    expect((await h("/v1/feed", { method: "POST", body: JSON.stringify(forged) })).status).toBe(401);
    // a row whose payload was edited no longer hashes to its sha
    const tampered = structuredClone(rows);
    (tampered[2] as FeedRow).payload_json = JSON.stringify({ symbol: "BTC/USD", pnl_cents: 9999 });
    expect((await h("/v1/feed", { method: "POST", body: await batch(k, tampered, now) })).status).toBe(422);
    // re-signing a rewritten history (different rows at the same seqs) is refused
    const rewritten = chain(6, 0, "1".repeat(64));
    expect((await h("/v1/feed", { method: "POST", body: await batch(k, rewritten, now) })).status).toBe(409);
    // an old batch replayed later is refused
    expect(
      (await call(db, now + 3_600_000)("/v1/feed", { method: "POST", body: await batch(k, rows, now) }))
        .status,
    ).toBe(400);
    // the feed and the leaderboard
    const feed = (await (await h(`/v1/agents/${k.agentId}/feed?after=3&kinds=EXIT`)).json()) as {
      rows: FeedRow[];
    };
    expect(feed.rows.map((r) => r.seq)).toEqual([4, 5, 6]);
    const lb = (await (await h("/v1/leaderboard")).json()) as {
      agents: { agent_id: string; trades: number; pnl_usd: number; win_rate: number }[];
    };
    expect(lb.agents[0]).toMatchObject({ agent_id: k.agentId, trades: 6, pnl_usd: 0.6, win_rate: 0.5 });
    // a history published long after it happened is stored but never counted (no backfilled track records)
    const late = await generateAgentKey();
    const old = chain(6, 0, "0".repeat(64), now - 48 * 3_600_000);
    expect((await h("/v1/feed", { method: "POST", body: await batch(late, old, now) })).status).toBe(200);
    const lb2 = (await (await h("/v1/leaderboard")).json()) as { agents: { agent_id: string }[] };
    expect(lb2.agents.map((a) => a.agent_id)).toEqual([k.agentId]);
    // published rows can't be deleted at the database level either
    expect(() => db.db.exec("DELETE FROM rows")).toThrow(/append-only/);
  });

  it("bounds the open write surface: per-agent row quota, new-agent cap, clean names (audit BL-3)", async () => {
    const db = hubDb();
    const now = 5_000_000;
    const h = call(db, now);
    const k = await generateAgentKey();
    const first = chain(6);
    const ok = await h("/v1/feed", { method: "POST", body: await batch(k, first, now, "**BUY $XYZ** <@1>") });
    expect(ok.status).toBe(200);
    expect(db.db.prepare("SELECT name FROM agents").get()).toEqual({ name: "BUY XYZ 1" });
    const saved = LIMITS.rowsPerAgentPerDay;
    LIMITS.rowsPerAgentPerDay = 8;
    try {
      const more = chain(6, 6, first.at(-1)?.row_sha256);
      expect((await h("/v1/feed", { method: "POST", body: await batch(k, more, now) })).status).toBe(429);
    } finally {
      LIMITS.rowsPerAgentPerDay = saved;
    }
    const cap = LIMITS.newAgentsPerDay;
    LIMITS.newAgentsPerDay = 1;
    try {
      const k2 = await generateAgentKey();
      expect((await h("/v1/feed", { method: "POST", body: await batch(k2, chain(2), now) })).status).toBe(
        429,
      );
    } finally {
      LIMITS.newAgentsPerDay = cap;
    }
  });

  it("packs: signed publish, browse, download count", async () => {
    const db = hubDb();
    const h = call(db, 1);
    const k = await generateAgentKey();
    const body = {
      v: 1 as const,
      kind: "memory" as const,
      title: "Crypto scars",
      description: "",
      public_key: k.publicKey,
      created_at: 1,
      content: { scar_rules: [], beliefs: [] },
    };
    const pack = { ...body, sig: await signPayload(k.privateKey, body) };
    const r = (await (await h("/v1/packs", { method: "POST", body: JSON.stringify(pack) })).json()) as {
      pack_id: string;
    };
    expect(r.pack_id).toMatch(/^[0-9a-f]{16}$/);
    expect(
      (await h("/v1/packs", { method: "POST", body: JSON.stringify({ ...pack, title: "Changed title" }) }))
        .status,
    ).toBe(401);
    expect(((await (await h(`/v1/packs/${r.pack_id}`)).json()) as { title: string }).title).toBe(
      "Crypto scars",
    );
    expect(
      ((await (await h("/v1/packs")).json()) as { packs: { downloads: number }[] }).packs[0]?.downloads,
    ).toBe(1);
  });
});

function brain(
  hubCfg: Record<string, string>,
  http: (u: string, i?: RequestInit) => Promise<Response>,
  now: () => number,
) {
  const m = new Market(now);
  const sql = memorySql();
  for (const s of HOT_SCHEMA) sql.exec(s);
  const b = new Brain({
    sql,
    d: doctrine,
    c: constitution,
    brokers: { PAPER: new FakeBroker(m, 54, now) },
    market: new FakeMarketData(m),
    notifier: new NullNotifier(),
    d1: memoryD1(),
    readKillFlag: async () => false,
    now,
    http,
    hub: hubFromEnv(hubCfg),
  });
  return { b, sql };
}

describe("agents on the hub (ADR-068)", () => {
  it("a leader publishes its court contracts; a follower gets them as Tier 2 leads, never as orders", async () => {
    const db = hubDb();
    let t = Date.UTC(2026, 9, 26, 15);
    const now = () => t;
    const http = async (u: string, i?: RequestInit) => call(db, t)(u, i);
    const lk = await generateAgentKey();
    const leader = brain(
      { HUB_URL: "https://hub.test", HUB_AGENT_KEY: lk.privateKey, HUB_AGENT_NAME: "leader" },
      http,
      now,
    );
    leader.b.journal.append(
      "SYSTEM",
      "CONTRACT",
      "k1",
      {
        symbol: "ETH/USD",
        strategy: "CRYPTO_CATALYST_COURT_V1",
        origin: "COURT",
        thesis: "ETF inflows",
        win: 0.64,
      },
      t,
    );
    leader.b.journal.append(
      "SYSTEM",
      "CANDIDATE_REJECT",
      "c1",
      { symbol: "SOL/USD", stage: "TIER0", reasons: ["x"] },
      t,
    ); // private: not published
    await (leader.b as unknown as { hubSync: (n: number) => Promise<void> }).hubSync(t);
    const rows = db.db.prepare("SELECT kind FROM rows").all() as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["CONTRACT"]);
    expect(leader.sql.exec("SELECT * FROM hub_outbox")).toEqual([]);

    const fk = await generateAgentKey();
    const follower = brain(
      {
        HUB_URL: "https://hub.test",
        HUB_AGENT_KEY: fk.privateKey,
        HUB_PUBLISH: "false",
        HUB_FOLLOW: lk.agentId,
      },
      http,
      now,
    );
    t += 60_000;
    await (follower.b as unknown as { hubSync: (n: number) => Promise<void> }).hubSync(t);
    const q = follower.sql.exec<{ candidate_id: string; tier: number; payload_json: string }>(
      "SELECT candidate_id, tier, payload_json FROM triage_queue",
    );
    expect(q).toHaveLength(1);
    expect(q[0]?.tier).toBe(2);
    expect(JSON.parse(q[0]?.payload_json ?? "{}").headline).toMatch(/Followed agent .*ETH\/USD: ETF inflows/);
    // the same lead never comes twice
    t += 31 * 60_000;
    await (follower.b as unknown as { hubSync: (n: number) => Promise<void> }).hubSync(t);
    expect(follower.sql.exec("SELECT * FROM triage_queue")).toHaveLength(1);
  });
});

describe("memory packs (ADR-068)", () => {
  it("export → stage (verified) → apply as local scar rules + half-confidence beliefs; tampering is refused", async () => {
    const k = await generateAgentKey();
    const sql = memorySql();
    for (const s of HOT_SCHEMA) sql.exec(s);
    sql.exec(
      "INSERT INTO beliefs VALUES ('b1', 'BTC/USD', 'Breakouts on Sunday nights fail more often than not', 0.8, 30, 1, 'ACTIVE')",
    );
    const scar = {
      version: 1,
      rules: [
        {
          id: "SCAR-001",
          kind: "hard_filter" as const,
          rule: "No crypto entries between 00 and 02 UTC on Sundays",
          expression: {
            all: [{ field: "utc_dow" as const, op: "==" as const, value: 0 }],
            action: "reject" as const,
          },
          evidence: ["a", "b", "c"],
          added: "2026-10-01",
        },
      ],
    };
    const pack = await exportPack(sql, scar as never, k.privateKey, "My scars", "", 1);
    const home = mkdtempSync(join(tmpdir(), "c54-pack-"));
    await expect(stagePack(home, { ...pack, title: "edited" })).rejects.toThrow(/signature/);
    const st = await stagePack(home, JSON.parse(JSON.stringify(pack)));
    expect(st).toMatchObject({ author: k.agentId, rules: 1, beliefs: 1 });
    expect(loadLocalScar(home).rules).toEqual([]); // staged only
    const other = memorySql();
    for (const s of HOT_SCHEMA) other.exec(s);
    const r = applyPack(home, other, st.id, 2);
    expect(r).toEqual({ rules: 1, beliefs: 1 });
    expect(loadLocalScar(home).rules[0]?.id).toBe("SCAR-9000");
    expect(other.exec<{ c0: number }>("SELECT c0 FROM beliefs")[0]?.c0).toBeCloseTo(0.4, 6);
    expect(applyPack(home, other, st.id, 3).rules).toBe(0); // idempotent
  });
});
