import { type HubDb, handleHub } from "./handler.ts";
import { handleImpact, runImpact, whopRevenue } from "./impact.ts";

/** Savant community hub Worker (ADR-068): the one service the publisher hosts. */
interface Env {
  DB: D1Database;
  /** Audit BL-3: per-IP limit on writes (wrangler `ratelimits`). */
  RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** ADR-102: a read-only Whop key (payment:basic:read) for the monthly revenue behind the impact pledge */
  WHOP_API_KEY?: string;
  WHOP_ACCOUNT_ID?: string;
}

function d1(db: D1Database): HubDb {
  return {
    all: async <T>(sql: string, ...b: unknown[]) =>
      ((
        await db
          .prepare(sql)
          .bind(...b)
          .all()
      ).results ?? []) as T[],
    first: async <T>(sql: string, ...b: unknown[]) =>
      (await db
        .prepare(sql)
        .bind(...b)
        .first()) as T | null,
    run: async (sql: string, ...b: unknown[]) => {
      await db
        .prepare(sql)
        .bind(...b)
        .run();
    },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST",
          "access-control-allow-headers": "content-type",
        },
      });
    const url = new URL(req.url);
    if (req.method === "POST" && env.RL) {
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await env.RL.limit({ key: ip })).success) return new Response("slow down", { status: 429 });
    }
    // the leaderboard scans every closing row: serve it from the edge cache for 5 minutes (audit BL-3)
    if (req.method === "GET" && url.pathname.replace(/\/+$/, "") === "/v1/leaderboard") {
      const cache = (caches as unknown as { default: Cache }).default;
      const key = new Request(url.toString(), { method: "GET" });
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await handleHub(req, d1(env.DB), Date.now());
      if (res.ok) {
        const copy = new Response(res.body, res);
        copy.headers.set("cache-control", "public, max-age=300");
        await cache.put(key, copy.clone());
        return copy;
      }
      return res;
    }
    // ADR-102: the impact pledge (getsavant.pro/impact)
    const impact = await handleImpact(
      req,
      d1(env.DB),
      Date.now(),
      req.headers.get("cf-connecting-ip") ?? "unknown",
    );
    if (impact) return impact;
    return handleHub(req, d1(env.DB), Date.now());
  },
  // ADR-102: daily — refresh this month's revenue tracker, and close and publish last month once it is over
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runImpact(
        d1(env.DB),
        whopRevenue(env, (u, i) => fetch(u, i)),
        Date.now(),
      ).then((r) => console.log(`[impact] ${r}`)),
    );
  },
} satisfies ExportedHandler<Env>;
