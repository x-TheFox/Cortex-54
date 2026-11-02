import { sha256Hex } from "../../src/lib/sha256.ts";
import type { HubDb } from "./handler.ts";

/**
 * Savant's community impact pledge (ADR-102), public at getsavant.pro/impact.
 *
 * The pledge: every month, 20% of Savant's gross revenue is given by the company to foundations the community
 * suggests. It is a corporate allocation of Savant's own revenue: nobody donates through Savant, Savant never collects
 * or holds anyone else's money, and the gift is made by the company directly to each foundation.
 *
 * Every month, automatically:
 *   1. gross revenue = every charge Savant collected in the calendar month (UTC), before payment-processor fees, less
 *      refunds issued in that month; read from the payment processor, refreshed daily for the live tracker
 *   2. pool = 20% of gross
 *   3. slots = how many foundations the pool funds: one per $SLOT_TARGET of pool, at least 1 (when the pool is above
 *      zero) and at most MAX_SLOTS; the pool is split equally across them
 *   4. winners = the most-supported eligible suggestions (deduplicated), ties to the earliest suggestion
 *   5. the month's report is published; when each gift is made, its receipt is attached (operator: `pnpm impact`)
 *
 * Suggestions are merged automatically when they are the same foundation: same website domain, or the same name once
 * legal suffixes, punctuation and articles are removed. A suggestion that wins is not eligible again for 3 months, so
 * the pool reaches more foundations over time.
 */

export const PLEDGE_SHARE = 0.2;
export const SLOT_TARGET_CENTS = 25_000; // one foundation per $250 of pool
export const MAX_SLOTS = 10;
export const COOLDOWN_MONTHS = 3;
const DAY = 86_400_000;

export const IMPACT_LIMITS = { suggestionsPerIpPerDay: 3, votesPerIpPerMonth: 10 };

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
export function monthRange(m: string): { from: number; to: number } {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1) };
}
export const prevMonth = (m: string) => monthOf(monthRange(m).from - 1);

/** How many foundations a pool funds. Pure. */
export function slotsFor(poolCents: number): number {
  if (poolCents <= 0) return 0;
  return Math.max(1, Math.min(MAX_SLOTS, Math.floor(poolCents / SLOT_TARGET_CENTS)));
}

/** Split a pool into `n` equal shares in cents; the remainder cents go to the first shares. Pure. */
export function split(poolCents: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(poolCents / n);
  return Array.from({ length: n }, (_, i) => base + (i < poolCents - base * n ? 1 : 0));
}

const SUFFIX =
  /\b(the|foundation|fund|inc|incorporated|llc|ltd|limited|org|organisation|organization|charity|charitable|trust|society|association|international|intl|co|corp|nonprofit|non profit|ngo|cic|gmbh|e\s?v)\b/g;

/** The identity of a foundation for deduplication: its website's domain, else its cleaned-up name. Pure. */
export function foundationKey(name: string, url?: string | null): string {
  const u = (url ?? "").trim();
  if (u) {
    try {
      const host = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname
        .toLowerCase()
        .replace(/^www\./, "");
      // the registrable part for common cases (donate.example.org → example.org)
      const parts = host.split(".");
      const two = parts.slice(-2).join(".");
      const keep = /^(co|org|com|net|gov|ac)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
      if (keep.includes(".")) return `d:${keep}`;
    } catch {
      /* fall back to the name */
    }
  }
  const n = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `n:${n}`;
}

export function cleanText(s: unknown, max: number): string {
  return typeof s === "string"
    ? [...s.normalize("NFKC")]
        .map((c) => (c.charCodeAt(0) < 32 ? " " : c))
        .join("")
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, max)
    : "";
}

export function cleanUrl(s: unknown): string | null {
  const t = cleanText(s, 300);
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return `https://${u.hostname.toLowerCase()}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ revenue (the payment processor)

export type Fetch = (u: string, i?: RequestInit) => Promise<Response>;
export interface RevenueSource {
  /** gross collected and refunded, in cents, for [from, to) */
  revenue(from: number, to: number): Promise<{ gross_cents: number; refunds_cents: number; charges: number }>;
}

const cents = (v: unknown): number => {
  if (v && typeof v === "object" && "amount" in (v as object))
    return Math.round(Number((v as { amount: string }).amount) * 100);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** Whop's payments API, paged, for the publisher's own account (read-only key with payment:basic:read). */
export function whopRevenue(
  env: { WHOP_API_KEY?: string; WHOP_ACCOUNT_ID?: string; WHOP_API_BASE?: string },
  f: Fetch,
): RevenueSource | null {
  if (!env.WHOP_API_KEY) return null;
  const base = (env.WHOP_API_BASE ?? "https://api.whop.com/api/v1").replace(/\/$/, "");
  const get = async (q: URLSearchParams) => {
    const r = await f(`${base}/payments?${q}`, { headers: { authorization: `Bearer ${env.WHOP_API_KEY}` } });
    if (!r.ok) throw new Error(`payments HTTP ${r.status}`);
    return (await r.json()) as {
      data?: {
        status?: string;
        substatus?: string;
        total?: unknown;
        refunded_amount?: unknown;
        refunded_at?: unknown;
        currency?: string;
        usd_total?: unknown;
        paid_at?: unknown;
      }[];
      page_info?: { has_next_page?: boolean; end_cursor?: string | null };
    };
  };
  return {
    async revenue(from, to) {
      let gross = 0;
      let refunds = 0;
      let charges = 0;
      let after: string | null = null;
      for (let page = 0; page < 200; page++) {
        const q = new URLSearchParams({
          created_after: new Date(from).toISOString(),
          created_before: new Date(to).toISOString(),
          first: "100",
        });
        if (env.WHOP_ACCOUNT_ID) q.set("account_id", env.WHOP_ACCOUNT_ID);
        if (after) q.set("after", after);
        const d = await get(q);
        for (const p of d.data ?? []) {
          if (p.status !== "paid" && p.substatus !== "refunded" && p.substatus !== "partially_refunded")
            continue;
          // USD amounts when the processor gives them (a charge in another currency is converted at its own rate)
          const total = cents(p.usd_total ?? p.total);
          gross += total;
          charges++;
          const at =
            typeof p.refunded_at === "string"
              ? Date.parse(p.refunded_at)
              : Number(p.refunded_at ?? 0) * (Number(p.refunded_at) < 1e12 ? 1000 : 1);
          const ref = Math.min(total, cents(p.refunded_amount));
          if (ref > 0 && (!at || (at >= from && at < to))) refunds += ref;
        }
        if (!d.page_info?.has_next_page || !d.page_info.end_cursor) break;
        after = d.page_info.end_cursor;
      }
      return { gross_cents: gross, refunds_cents: refunds, charges };
    },
  };
}

// ------------------------------------------------------------------ the monthly pipeline

export interface MonthRow {
  month: string;
  gross_cents: number;
  refunds_cents: number;
  net_cents: number;
  pool_cents: number;
  slots: number;
  charges: number;
  status: "live" | "published";
  computed_at: number;
  published_at: number | null;
}

/** Refresh the live month's tracker (daily). */
export async function refreshMonth(db: HubDb, src: RevenueSource, m: string, now: number): Promise<MonthRow> {
  const { from, to } = monthRange(m);
  const r = await src.revenue(from, Math.min(to, now));
  const net = Math.max(0, r.gross_cents - r.refunds_cents);
  const pool = Math.floor(net * PLEDGE_SHARE);
  const row: MonthRow = {
    month: m,
    gross_cents: r.gross_cents,
    refunds_cents: r.refunds_cents,
    net_cents: net,
    pool_cents: pool,
    slots: slotsFor(pool),
    charges: r.charges,
    status: "live",
    computed_at: now,
    published_at: null,
  };
  const existing = await db.first<{ status: string }>("SELECT status FROM impact_months WHERE month = ?", m);
  if (existing?.status === "published")
    return (await db.first<MonthRow>("SELECT * FROM impact_months WHERE month = ?", m)) as MonthRow;
  await db.run(
    `INSERT INTO impact_months (month, gross_cents, refunds_cents, net_cents, pool_cents, slots, charges, status, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)
     ON CONFLICT(month) DO UPDATE SET gross_cents = excluded.gross_cents, refunds_cents = excluded.refunds_cents,
       net_cents = excluded.net_cents, pool_cents = excluded.pool_cents, slots = excluded.slots,
       charges = excluded.charges, computed_at = excluded.computed_at`,
    m,
    row.gross_cents,
    row.refunds_cents,
    row.net_cents,
    row.pool_cents,
    row.slots,
    row.charges,
    now,
  );
  return row;
}

/** The suggestions that would win now (eligible, most supported, earliest first on ties). */
export async function leaders(
  db: HubDb,
  month: string,
  n: number,
): Promise<{ id: number; name: string; url: string | null; votes: number }[]> {
  if (n <= 0) return [];
  const recent = Array.from({ length: COOLDOWN_MONTHS }, (_, i) => {
    let m = month;
    for (let k = 0; k <= i; k++) m = prevMonth(m);
    return m;
  });
  return db.all(
    `SELECT s.id, s.name, s.url, s.votes FROM impact_suggestions s
     WHERE s.status = 'listed'
       AND s.id NOT IN (SELECT suggestion_id FROM impact_allocations WHERE month IN (${recent.map(() => "?").join(",")}))
     ORDER BY s.votes DESC, s.created_at ASC, s.id ASC LIMIT ?`,
    ...recent,
    n,
  );
}

/** Close a finished month: final revenue, winners, equal split, published. Idempotent. */
export async function closeMonth(
  db: HubDb,
  src: RevenueSource,
  m: string,
  now: number,
): Promise<MonthRow | null> {
  const done = await db.first<MonthRow>(
    "SELECT * FROM impact_months WHERE month = ? AND status = 'published'",
    m,
  );
  if (done) return done;
  if (monthRange(m).to > now) return null; // not over yet
  const row = await refreshMonth(db, src, m, now);
  const win = await leaders(db, m, row.slots);
  const shares = split(row.pool_cents, win.length);
  for (const [i, w] of win.entries())
    await db.run(
      "INSERT OR IGNORE INTO impact_allocations (month, suggestion_id, name, url, votes, amount_cents) VALUES (?, ?, ?, ?, ?, ?)",
      m,
      w.id,
      w.name,
      w.url,
      w.votes,
      shares[i] ?? 0,
    );
  await db.run(
    "UPDATE impact_months SET status = 'published', published_at = ?, slots = ? WHERE month = ?",
    now,
    win.length,
    m,
  );
  return { ...row, slots: win.length, status: "published", published_at: now };
}

/** The scheduled job (daily): refresh this month's tracker; close any finished month not yet published. */
export async function runImpact(db: HubDb, src: RevenueSource | null, now: number): Promise<string> {
  if (!src) return "no revenue source (WHOP_API_KEY not set)";
  const cur = monthOf(now);
  await refreshMonth(db, src, cur, now);
  const prev = prevMonth(cur);
  const closed = await closeMonth(db, src, prev, now);
  return `refreshed ${cur}${closed ? `; ${prev} ${closed.status}` : ""}`;
}

// ------------------------------------------------------------------ the public API

const json = (b: unknown, status = 200, cache = "no-store") =>
  Response.json(b, { status, headers: { "access-control-allow-origin": "*", "cache-control": cache } });

export async function handleImpact(
  req: Request,
  db: HubDb,
  now: number,
  ipKey: string,
): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "");
  if (!p.startsWith("/v1/impact")) return null;
  const ip = sha256Hex(`savant-impact:${ipKey}`).slice(0, 16);
  if (req.method === "GET" && p === "/v1/impact") {
    const m = monthOf(now);
    const cur = await db.first<MonthRow>("SELECT * FROM impact_months WHERE month = ?", m);
    const slots = cur?.slots ?? 0;
    const sugg = await db.all<{
      id: number;
      name: string;
      url: string | null;
      reason: string;
      votes: number;
      created_at: number;
    }>(
      "SELECT id, name, url, reason, votes, created_at FROM impact_suggestions WHERE status = 'listed' ORDER BY votes DESC, created_at ASC LIMIT 100",
    );
    const lead = new Set((await leaders(db, m, slots)).map((x) => x.id));
    const months = await db.all<MonthRow>(
      "SELECT * FROM impact_months WHERE status = 'published' ORDER BY month DESC LIMIT 36",
    );
    const alloc = await db.all<{
      month: string;
      name: string;
      url: string | null;
      amount_cents: number;
      paid_cents: number | null;
      receipt_url: string | null;
      paid_at: number | null;
      votes: number;
    }>(
      `SELECT month, name, url, amount_cents, paid_cents, receipt_url, paid_at, votes FROM impact_allocations
       WHERE month IN (SELECT month FROM impact_months WHERE status = 'published' ORDER BY month DESC LIMIT 36) ORDER BY month DESC, amount_cents DESC, votes DESC`,
    );
    const totals = await db.first<{ pledged: number; paid: number }>(
      "SELECT COALESCE(SUM(amount_cents), 0) AS pledged, COALESCE(SUM(paid_cents), 0) AS paid FROM impact_allocations",
    );
    const { to } = monthRange(m);
    return json(
      {
        share: PLEDGE_SHARE,
        slot_target_cents: SLOT_TARGET_CENTS,
        max_slots: MAX_SLOTS,
        current: cur
          ? { ...cur, days_left: Math.max(0, Math.ceil((to - now) / DAY)), closes_at: to }
          : {
              month: m,
              gross_cents: 0,
              refunds_cents: 0,
              net_cents: 0,
              pool_cents: 0,
              slots: 0,
              charges: 0,
              status: "live",
              computed_at: null,
              days_left: Math.ceil((to - now) / DAY),
              closes_at: to,
            },
        suggestions: sugg.map((s) => ({ ...s, leading: lead.has(s.id) })),
        months: months.map((x) => ({ ...x, allocations: alloc.filter((a) => a.month === x.month) })),
        totals: { pledged_cents: totals?.pledged ?? 0, paid_cents: totals?.paid ?? 0 },
      },
      200,
      "public, max-age=60",
    );
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try {
    const t = await req.text();
    if (t.length > 4_000) return json({ error: "too large" }, 413);
    body = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (p === "/v1/impact/suggest") {
    const name = cleanText(body.name, 120);
    const site = cleanUrl(body.url);
    const reason = cleanText(body.reason, 400);
    if (name.length < 3) return json({ ok: false, message: "Give the foundation's name." }, 400);
    if (!site)
      return json(
        { ok: false, message: "Add the foundation's website, so we can verify it and merge duplicates." },
        400,
      );
    const key = foundationKey(name, site);
    const nameKey = foundationKey(name);
    const dup = await db.first<{ id: number; name: string; status: string }>(
      "SELECT id, name, status FROM impact_suggestions WHERE key = ? OR name_key = ? ORDER BY id LIMIT 1",
      key,
      nameKey,
    );
    if (dup) {
      if (dup.status === "rejected")
        return json(
          {
            ok: false,
            message: `${dup.name} was reviewed and isn't eligible (it must be a registered nonprofit).`,
          },
          409,
        );
      const v = await vote(db, dup.id, ip, now);
      return json({
        ok: true,
        merged: true,
        id: dup.id,
        message: `${dup.name} is already suggested. ${v.ok ? "Your support was added to it." : v.message}`,
      });
    }
    const today = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM impact_suggestions WHERE ip = ? AND created_at > ?",
      ip,
      now - DAY,
    );
    if ((today?.n ?? 0) >= IMPACT_LIMITS.suggestionsPerIpPerDay)
      return json({ ok: false, message: "That's enough suggestions from you for today. Thank you!" }, 429);
    await db.run(
      "INSERT INTO impact_suggestions (key, name_key, name, url, reason, votes, status, ip, created_at) VALUES (?, ?, ?, ?, ?, 0, 'listed', ?, ?)",
      key,
      nameKey,
      name,
      site,
      reason,
      ip,
      now,
    );
    const row = await db.first<{ id: number }>("SELECT id FROM impact_suggestions WHERE key = ?", key);
    if (row) await vote(db, row.id, ip, now);
    return json({ ok: true, id: row?.id, message: `Thanks! ${name} is on the list with your support.` });
  }
  if (p === "/v1/impact/vote") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ ok: false, message: "Which foundation?" }, 400);
    const r = await vote(db, id, ip, now);
    return json(r, r.ok ? 200 : 409);
  }
  return json({ error: "not found" }, 404);
}

async function vote(
  db: HubDb,
  id: number,
  ip: string,
  now: number,
): Promise<{ ok: boolean; message: string }> {
  const s = await db.first<{ status: string }>("SELECT status FROM impact_suggestions WHERE id = ?", id);
  if (s?.status !== "listed") return { ok: false, message: "That foundation isn't on the list." };
  const m = monthOf(now);
  const mine = await db.first<{ n: number; here: number }>(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN suggestion_id = ? THEN 1 ELSE 0 END) AS here FROM impact_votes WHERE ip = ? AND month = ?",
    id,
    ip,
    m,
  );
  if ((mine?.here ?? 0) > 0) return { ok: false, message: "You already support this one this month." };
  if ((mine?.n ?? 0) >= IMPACT_LIMITS.votesPerIpPerMonth)
    return {
      ok: false,
      message: `You can support up to ${IMPACT_LIMITS.votesPerIpPerMonth} foundations a month.`,
    };
  await db.run("INSERT INTO impact_votes (suggestion_id, ip, month, at) VALUES (?, ?, ?, ?)", id, ip, m, now);
  await db.run("UPDATE impact_suggestions SET votes = votes + 1 WHERE id = ?", id);
  return { ok: true, message: "Thanks for your support." };
}
