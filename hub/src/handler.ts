import {
  agentIdOf,
  FeedBatchSchema,
  PackSchema,
  rowIsConsistent,
  unsigned,
  verifyPayload,
} from "../../src/hub/protocol.ts";
import { sha256Hex } from "../../src/lib/sha256.ts";

/**
 * The hub's HTTP API (ADR-068). Plain fetch semantics over a tiny DB interface, so the same code runs as a Worker
 * on D1 and in tests on SQLite.
 *
 *   POST /v1/feed                         signed batch of journal rows from an agent
 *   GET  /v1/agents/:id/feed?after&kinds  an agent's published rows (what followers read)
 *   GET  /v1/agents/:id                   agent card: head, trades, verification
 *   GET  /v1/leaderboard                  agents with ≥ 5 closed trades, verified rows only
 *   POST /v1/packs                        publish a signed pack
 *   GET  /v1/packs  /v1/packs/:id         browse / download packs
 */
export interface HubDb {
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<void>;
}

const json = (b: unknown, status = 200) =>
  Response.json(b, { status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });

const MAX_BODY = 1_000_000;

export async function handleHub(req: Request, db: HubDb, now: number): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "");
  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    if (p === "/v1/feed") return feed(body, db, now);
    if (p === "/v1/packs") return publishPack(body, db, now);
    return json({ error: "not found" }, 404);
  }
  if (req.method !== "GET") return json({ error: "method" }, 405);
  if (p === "/v1/leaderboard") return leaderboard(db);
  if (p === "/v1/packs") {
    const rows = await db.all<{
      pack_id: string;
      agent_id: string;
      kind: string;
      title: string;
      created_at: number;
      downloads: number;
    }>(
      "SELECT pack_id, agent_id, kind, title, created_at, downloads FROM packs ORDER BY downloads DESC, created_at DESC LIMIT 100",
    );
    return json({ packs: rows });
  }
  let m = /^\/v1\/packs\/([0-9a-f]{16})$/.exec(p);
  if (m) {
    const row = await db.first<{ json: string }>("SELECT json FROM packs WHERE pack_id = ?", m[1]);
    if (!row) return json({ error: "no such pack" }, 404);
    await db.run("UPDATE packs SET downloads = downloads + 1 WHERE pack_id = ?", m[1]);
    return json(JSON.parse(row.json));
  }
  m = /^\/v1\/agents\/([0-9a-f]{16})\/feed$/.exec(p);
  if (m) {
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const kinds = (url.searchParams.get("kinds") ?? "")
      .split(",")
      .filter((k) => /^[A-Z_]{2,40}$/.test(k))
      .slice(0, 10);
    const rows = await db.all(
      `SELECT seq, ts, account, kind, ref_id, payload_json, prev_row_sha256, row_sha256 FROM rows
       WHERE agent_id = ? AND seq > ? ${kinds.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""}
       ORDER BY seq LIMIT 200`,
      m[1],
      after,
      ...kinds,
    );
    return json({ agent_id: m[1], rows });
  }
  m = /^\/v1\/agents\/([0-9a-f]{16})$/.exec(p);
  if (m) {
    const a = await db.first(
      "SELECT agent_id, name, first_seen, head_seq, head_sha, head_at FROM agents WHERE agent_id = ?",
      m[1],
    );
    return a
      ? json({ agent: a, record: (await records(db, m[1]))[0] ?? null })
      : json({ error: "no such agent" }, 404);
  }
  if (p === "" || p === "/v1") return json({ name: "CORTEX hub", version: 1 });
  return json({ error: "not found" }, 404);
}

async function feed(body: unknown, db: HubDb, now: number): Promise<Response> {
  const parsed = FeedBatchSchema.safeParse(body);
  if (!parsed.success) return json({ error: "bad batch" }, 400);
  const b = parsed.data;
  if (Math.abs(now - b.sent_at) > 15 * 60_000) return json({ error: "stale or future batch" }, 400);
  if (!(await verifyPayload(b.public_key, unsigned(b), b.sig))) return json({ error: "bad signature" }, 401);
  const id = agentIdOf(b.public_key);
  const bad = b.rows.find((r) => !rowIsConsistent(r) || r.seq > b.head.seq);
  if (bad) return json({ error: `row ${bad.seq} does not hash to what it claims` }, 422);
  const prev = await db.first<{ head_seq: number }>("SELECT head_seq FROM agents WHERE agent_id = ?", id);
  if (prev && b.head.seq < prev.head_seq)
    return json({ error: "head went backwards (journal rewritten?)" }, 409);
  // a row already published must not change (its hash is the record)
  for (const r of b.rows) {
    const old = await db.first<{ row_sha256: string }>(
      "SELECT row_sha256 FROM rows WHERE agent_id = ? AND seq = ?",
      id,
      r.seq,
    );
    if (old && old.row_sha256 !== r.row_sha256)
      return json({ error: `row ${r.seq} differs from what was published` }, 409);
  }
  if (!prev)
    await db.run(
      "INSERT INTO agents (agent_id, public_key, name, first_seen) VALUES (?, ?, ?, ?)",
      id,
      b.public_key,
      b.name ?? null,
      now,
    );
  for (const r of b.rows)
    await db.run(
      `INSERT OR IGNORE INTO rows (agent_id, seq, ts, account, kind, ref_id, payload_json, prev_row_sha256, row_sha256, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      r.seq,
      r.ts,
      r.account,
      r.kind,
      r.ref_id,
      r.payload_json,
      r.prev_row_sha256,
      r.row_sha256,
      now,
    );
  await db.run(
    "UPDATE agents SET head_seq = ?, head_sha = ?, head_at = ?, name = COALESCE(?, name) WHERE agent_id = ?",
    b.head.seq,
    b.head.sha,
    now,
    b.name ?? null,
    id,
  );
  return json({ ok: true, agent_id: id, stored: b.rows.length });
}

async function publishPack(body: unknown, db: HubDb, now: number): Promise<Response> {
  const parsed = PackSchema.safeParse(body);
  if (!parsed.success) return json({ error: "bad pack" }, 400);
  const pk = parsed.data;
  if (!(await verifyPayload(pk.public_key, unsigned(pk), pk.sig)))
    return json({ error: "bad signature" }, 401);
  const packId = sha256Hex(JSON.stringify(pk)).slice(0, 16);
  await db.run(
    "INSERT OR IGNORE INTO packs (pack_id, agent_id, kind, title, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    packId,
    agentIdOf(pk.public_key),
    pk.kind,
    pk.title,
    JSON.stringify(pk),
    now,
  );
  return json({ ok: true, pack_id: packId });
}

interface Record_ {
  agent_id: string;
  name: string | null;
  trades: number;
  wins: number;
  pnl_usd: number;
  avg_capture: number | null;
}

async function records(db: HubDb, agent?: string): Promise<Record_[]> {
  const rows = await db.all<{ agent_id: string; name: string | null; kind: string; payload_json: string }>(
    `SELECT r.agent_id, a.name, r.kind, r.payload_json FROM rows r JOIN agents a ON a.agent_id = r.agent_id
     WHERE r.kind IN ('EXIT', 'EXCURSIONS') ${agent ? "AND r.agent_id = ?" : ""}`,
    ...(agent ? [agent] : []),
  );
  const by = new Map<string, Record_ & { caps: number[] }>();
  for (const r of rows) {
    const x = by.get(r.agent_id) ?? {
      agent_id: r.agent_id,
      name: r.name,
      trades: 0,
      wins: 0,
      pnl_usd: 0,
      avg_capture: null,
      caps: [],
    };
    const pl = JSON.parse(r.payload_json) as { pnl_cents?: number; mfe_r?: number; mae_r?: number };
    if (r.kind === "EXIT" && typeof pl.pnl_cents === "number") {
      x.trades++;
      if (pl.pnl_cents > 0) x.wins++;
      x.pnl_usd = Math.round((x.pnl_usd + pl.pnl_cents / 100) * 100) / 100;
    }
    if (r.kind === "EXCURSIONS" && typeof pl.mfe_r === "number" && pl.mfe_r > 0.25) x.caps.push(pl.mfe_r);
    by.set(r.agent_id, x);
  }
  return [...by.values()].map(({ caps: _c, ...rest }) => rest);
}

async function leaderboard(db: HubDb): Promise<Response> {
  const all = (await records(db)).filter((r) => r.trades >= 5);
  all.sort((a, b) => b.pnl_usd - a.pnl_usd);
  return json({
    note: "Every row is signed by its agent and hash-linked to the row before it; published rows can't be edited.",
    agents: all.slice(0, 100).map((r) => ({ ...r, win_rate: Math.round((r.wins / r.trades) * 100) / 100 })),
  });
}
