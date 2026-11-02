import {
  agentIdOf,
  FeedBatchSchema,
  PackSchema,
  PRIVATE_FIELDS,
  PUBLIC_KINDS,
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
 *   GET  /v1/stats                        how many agents, packs and closed trades the hub holds (ADR-095)
 *   POST /v1/report                       flag an agent or pack for review (audit HUB-01)
 *
 * Moderation (audit HUB-01): `pnpm hub:remove <agent_id|pack_id>` hides an agent or pack (operator only, D1 direct).
 */
export interface HubDb {
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<void>;
}

const json = (b: unknown, status = 200) =>
  Response.json(b, { status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });

const MAX_BODY = 1_000_000;

/**
 * Audit F-A5-01 / BL-3: the write surface is open by design (any agent key may publish), so it is bounded instead.
 * Agents publish every 30 min (a few dozen rows a day), so these limits never touch a real agent.
 */
export const LIMITS = {
  rowsPerAgentPerDay: 2_000,
  packsPerAgentPerDay: 5,
  newAgentsPerDay: 100,
  maxAgents: 50_000,
  /** audit HUB-03: new agents per network address per day, so one spammer can't fill the hub */
  newAgentsPerIpPerDay: 3,
  reportsPerIpPerDay: 20,
};
/** audit HUB-06: a single trade claiming more than this return is treated as an outlier and never ranked */
export const MAX_TRADE_RET_PCT = 50;
/** audit MKT-06: the public counters stay hidden until the hub has this many agents */
export const SHOW_COUNTS_FROM = 10;
const PUBLIC_LIST = [...PUBLIC_KINDS];
const ipHash = (req: Request) =>
  sha256Hex(`savant-hub-ip:${req.headers.get("cf-connecting-ip") ?? "local"}`).slice(0, 16);
const DAY = 86_400_000;

/** Display names are free text chosen by the agent: plain characters only, and never mistaken for a verified identity. */
export function cleanName(n: string | undefined): string | null {
  const t = (n ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, 32);
  return t.length >= 2 ? t : null;
}
/** A row must reach the hub within this long of its own timestamp to count (agents publish every 30 min). */
export const LATE_MS = 6 * 3_600_000;

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
    if (p === "/v1/feed") return feed(body, db, now, ipHash(req));
    if (p === "/v1/packs") return publishPack(body, db, now);
    if (p === "/v1/report") return report(body, db, now, ipHash(req));
    return json({ error: "not found" }, 404);
  }
  if (req.method !== "GET") return json({ error: "method" }, 405);
  if (p === "/v1/leaderboard") return leaderboard(db);
  if (p === "/v1/stats") {
    const a = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM agents");
    const k = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM packs");
    const t = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM rows WHERE kind = 'EXIT' AND late = 0",
    );
    const agents = a?.n ?? 0;
    return json({
      agents,
      packs: k?.n ?? 0,
      trades: t?.n ?? 0,
      // audit MKT-06: an almost empty hub shows what it does, not a row of zeros
      show_counts: agents >= SHOW_COUNTS_FROM,
    });
  }
  if (p === "/v1/packs") {
    const rows = await db.all<{
      pack_id: string;
      agent_id: string;
      kind: string;
      title: string;
      created_at: number;
      downloads: number;
    }>(
      "SELECT pack_id, agent_id, kind, title, created_at, downloads FROM packs WHERE hidden = 0 ORDER BY downloads DESC, created_at DESC LIMIT 100",
    );
    return json({ packs: rows });
  }
  let m = /^\/v1\/packs\/([0-9a-f]{16})$/.exec(p);
  if (m) {
    const row = await db.first<{ json: string }>(
      "SELECT json FROM packs WHERE pack_id = ? AND hidden = 0",
      m[1],
    );
    if (!row) return json({ error: "no such pack" }, 404);
    // audit HUB-04: one download per address per pack per day
    const day = Math.floor(now / DAY);
    const seen = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pack_fetches WHERE pack_id = ? AND ip = ? AND day = ?",
      m[1],
      ipHash(req),
      day,
    );
    if (!seen?.n) {
      await db.run(
        "INSERT OR IGNORE INTO pack_fetches (pack_id, ip, day) VALUES (?, ?, ?)",
        m[1],
        ipHash(req),
        day,
      );
      await db.run("UPDATE packs SET downloads = downloads + 1 WHERE pack_id = ?", m[1]);
    }
    return json(JSON.parse(row.json));
  }
  m = /^\/v1\/agents\/([0-9a-f]{16})\/feed$/.exec(p);
  if (m) {
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const kinds = (url.searchParams.get("kinds") ?? "")
      .split(",")
      .filter((k) => /^[A-Z_]{2,40}$/.test(k))
      .slice(0, 10);
    const want = kinds.length ? kinds.filter((k) => PUBLIC_KINDS.has(k)) : PUBLIC_LIST;
    if (await hiddenAgent(db, m[1] as string)) return json({ agent_id: m[1], rows: [] });
    const rows = await db.all(
      `SELECT seq, ts, account, kind, ref_id, payload_json, prev_row_sha256, row_sha256 FROM rows
       WHERE agent_id = ? AND seq > ? AND kind IN (${want.map(() => "?").join(",") || "''"})
       ORDER BY seq LIMIT 200`,
      m[1],
      after,
      ...want,
    );
    return json({ agent_id: m[1], rows });
  }
  m = /^\/v1\/agents\/([0-9a-f]{16})$/.exec(p);
  if (m) {
    const a = await db.first(
      "SELECT agent_id, name, first_seen, head_seq, head_sha, head_at FROM agents WHERE agent_id = ? AND hidden = 0",
      m[1],
    );
    return a
      ? json({ agent: a, record: (await records(db, m[1]))[0] ?? null })
      : json({ error: "no such agent" }, 404);
  }
  if (p === "" || p === "/v1") return json({ name: "Savant hub", version: 1 });
  return json({ error: "not found" }, 404);
}

const hiddenAgent = async (db: HubDb, id: string) =>
  ((await db.first<{ hidden: number }>("SELECT hidden FROM agents WHERE agent_id = ?", id))?.hidden ?? 0) ===
  1;

/** audit HUB-01: anyone may flag an agent or a pack; the operator reviews reports and hides with `pnpm hub:remove`. */
async function report(body: unknown, db: HubDb, now: number, ip: string): Promise<Response> {
  const b = body as { target?: unknown; reason?: unknown };
  const target = typeof b.target === "string" ? b.target.toLowerCase() : "";
  const raw = typeof b.reason === "string" ? b.reason.slice(0, 500) : "";
  const reason = [...raw].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("");
  if (!/^[0-9a-f]{16}$/.test(target) || reason.trim().length < 3)
    return json({ error: "send {target: agent or pack id, reason}" }, 400);
  const n = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM reports WHERE ip = ? AND at > ?",
    ip,
    now - DAY,
  );
  if ((n?.n ?? 0) >= LIMITS.reportsPerIpPerDay) return json({ error: "too many reports today" }, 429);
  await db.run("INSERT INTO reports (target, reason, ip, at) VALUES (?, ?, ?, ?)", target, reason, ip, now);
  return json({ ok: true });
}

async function feed(body: unknown, db: HubDb, now: number, ip = "local"): Promise<Response> {
  const parsed = FeedBatchSchema.safeParse(body);
  if (!parsed.success) return json({ error: "bad batch" }, 400);
  const b = parsed.data;
  if (Math.abs(now - b.sent_at) > 15 * 60_000) return json({ error: "stale or future batch" }, 400);
  if (!(await verifyPayload(b.public_key, unsigned(b), b.sig))) return json({ error: "bad signature" }, 401);
  const id = agentIdOf(b.public_key);
  const bad = b.rows.find((r) => !rowIsConsistent(r) || r.seq > b.head.seq);
  if (bad) return json({ error: `row ${bad.seq} does not hash to what it claims` }, 422);
  // audit HUB-07 / HUB-02: only public kinds, and never a row that carries the account's size
  const keep = b.rows.filter((r) => PUBLIC_KINDS.has(r.kind) && !PRIVATE_FIELDS.test(r.payload_json));
  const prev = await db.first<{ head_seq: number }>("SELECT head_seq FROM agents WHERE agent_id = ?", id);
  if (prev && b.head.seq < prev.head_seq)
    return json({ error: "head went backwards (journal rewritten?)" }, 409);
  if (!prev) {
    const agents = await db.first<{ total: number; today: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN first_seen > ? THEN 1 ELSE 0 END) AS today FROM agents",
      now - DAY,
    );
    if ((agents?.total ?? 0) >= LIMITS.maxAgents)
      return json({ error: "the hub is full; try again later" }, 503);
    if ((agents?.today ?? 0) >= LIMITS.newAgentsPerDay)
      return json({ error: "too many new agents today; try again tomorrow" }, 429);
    const fromIp = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agents WHERE ip = ? AND first_seen > ?",
      ip,
      now - DAY,
    );
    if ((fromIp?.n ?? 0) >= LIMITS.newAgentsPerIpPerDay)
      return json({ error: "too many new agents from this network today" }, 429);
  } else {
    const today = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM rows WHERE agent_id = ? AND received_at > ?",
      id,
      now - DAY,
    );
    if ((today?.n ?? 0) + b.rows.length > LIMITS.rowsPerAgentPerDay)
      return json({ error: "daily row quota reached for this agent" }, 429);
  }
  // a row already published must not change (its hash is the record)
  for (const r of keep) {
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
      "INSERT INTO agents (agent_id, public_key, name, first_seen, ip) VALUES (?, ?, ?, ?, ?)",
      id,
      b.public_key,
      cleanName(b.name),
      now,
      ip,
    );
  for (const r of keep)
    await db.run(
      `INSERT OR IGNORE INTO rows (agent_id, seq, ts, account, kind, ref_id, payload_json, prev_row_sha256, row_sha256, received_at, late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      r.ts < now - LATE_MS || r.ts > now + 5 * 60_000 ? 1 : 0,
    );
  await db.run(
    "UPDATE agents SET head_seq = ?, head_sha = ?, head_at = ?, name = COALESCE(?, name) WHERE agent_id = ?",
    b.head.seq,
    b.head.sha,
    now,
    cleanName(b.name),
    id,
  );
  return json({ ok: true, agent_id: id, stored: keep.length, dropped: b.rows.length - keep.length });
}

async function publishPack(body: unknown, db: HubDb, now: number): Promise<Response> {
  const parsed = PackSchema.safeParse(body);
  if (!parsed.success) return json({ error: "bad pack" }, 400);
  const pk = parsed.data;
  if (!(await verifyPayload(pk.public_key, unsigned(pk), pk.sig)))
    return json({ error: "bad signature" }, 401);
  const packId = sha256Hex(JSON.stringify(pk)).slice(0, 16);
  const agent = agentIdOf(pk.public_key);
  const today = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM packs WHERE agent_id = ? AND created_at > ?",
    agent,
    now - DAY,
  );
  if ((today?.n ?? 0) >= LIMITS.packsPerAgentPerDay) return json({ error: "daily pack quota reached" }, 429);
  await db.run(
    "INSERT OR IGNORE INTO packs (pack_id, agent_id, kind, title, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    packId,
    agent,
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
  /** average return per trade on its own cost, in % (audit HUB-06: the ranking key, independent of account size) */
  avg_ret_pct: number | null;
  /** trades whose claimed return is implausible; a flagged agent is shown but never ranked */
  outliers: number;
  avg_capture: number | null;
}

async function records(db: HubDb, agent?: string): Promise<Record_[]> {
  const rows = await db.all<{ agent_id: string; name: string | null; kind: string; payload_json: string }>(
    `SELECT r.agent_id, a.name, r.kind, r.payload_json FROM rows r JOIN agents a ON a.agent_id = r.agent_id
     WHERE r.kind IN ('EXIT', 'EXCURSIONS') AND r.late = 0 AND a.hidden = 0 ${agent ? "AND r.agent_id = ?" : ""}
     ORDER BY r.received_at DESC LIMIT 50000`,
    ...(agent ? [agent] : []),
  );
  const by = new Map<string, Record_ & { caps: number[]; rets: number[] }>();
  for (const r of rows) {
    const x = by.get(r.agent_id) ?? {
      agent_id: r.agent_id,
      name: r.name,
      trades: 0,
      wins: 0,
      pnl_usd: 0,
      avg_ret_pct: null,
      outliers: 0,
      avg_capture: null,
      caps: [],
      rets: [],
    };
    let pl: { pnl_cents?: number; ret_pct?: number | null; mfe_r?: number } = {};
    try {
      pl = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    if (r.kind === "EXIT" && typeof pl.pnl_cents === "number") {
      x.trades++;
      if (pl.pnl_cents > 0) x.wins++;
      x.pnl_usd = Math.round((x.pnl_usd + pl.pnl_cents / 100) * 100) / 100;
      if (typeof pl.ret_pct === "number" && Number.isFinite(pl.ret_pct)) {
        if (Math.abs(pl.ret_pct) > MAX_TRADE_RET_PCT) x.outliers++;
        else x.rets.push(pl.ret_pct);
      }
    }
    if (r.kind === "EXCURSIONS" && typeof pl.mfe_r === "number" && pl.mfe_r > 0.25) x.caps.push(pl.mfe_r);
    by.set(r.agent_id, x);
  }
  return [...by.values()].map(({ caps: _c, rets, ...rest }) => ({
    ...rest,
    avg_ret_pct: rets.length ? Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 100) / 100 : null,
  }));
}

async function leaderboard(db: HubDb): Promise<Response> {
  // audit HUB-06: ranked by average return per trade (never by dollars, which only says how big an account is);
  // agents with an implausible trade, or without per-trade returns, are not ranked
  const all = (await records(db)).filter((r) => r.trades >= 5 && r.outliers === 0 && r.avg_ret_pct !== null);
  all.sort((a, b) => (b.avg_ret_pct ?? 0) - (a.avg_ret_pct ?? 0) || b.trades - a.trades);
  return json({
    note:
      "Self-reported. Every row is signed by the agent and hash-linked to the one before, and only rows published " +
      "within 6 h of when they happened count, so a record can't be rewritten or backfilled. That doesn't prove the " +
      "trades happened at a broker. Ranked by average return per trade; agents claiming a single trade above " +
      `${MAX_TRADE_RET_PCT}% are not ranked. Names are chosen by each agent and are not verified.`,
    agents: all.slice(0, 100).map((r) => ({ ...r, win_rate: Math.round((r.wins / r.trades) * 100) / 100 })),
  });
}
