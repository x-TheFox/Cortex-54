import { SCAR_TISSUE } from "../generated/config.ts";
import { type CommandArgs, type OperatorBrain, runCommand } from "./commands.ts";
import {
  cookieValue,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  signToken,
  verifyToken,
} from "./session.ts";

/**
 * Web terminal API (Phase 6, ADR-034). Routing only (10 ms CPU): every read is one DO RPC or one D1 query.
 * Mutations need the session cookie (HttpOnly, SameSite=Strict) and the `x-cortex-web: 1` header.
 */

/** The slice of Env the web API needs (kept narrow so it also runs under Node in tests). */
export interface WebEnv {
  WEB_SESSION_SECRET?: string | undefined;
  OPERATOR_DISCORD_ID?: string | undefined;
  DB?:
    | { prepare(sql: string): { bind(...v: unknown[]): { all(): Promise<{ results?: unknown[] }> } } }
    | undefined;
}

export interface WebBrain extends OperatorBrain {
  status(): Promise<unknown>;
  memory(): Promise<unknown>;
  equity(days: number): Promise<unknown>;
  forecast(symbol: string): Promise<unknown>;
  consumeOnce(id: string): Promise<boolean>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

async function session(request: Request, env: WebEnv): Promise<boolean> {
  const secret = env.WEB_SESSION_SECRET;
  if (!secret) return false;
  return (
    (await verifyToken(
      secret,
      cookieValue(request.headers.get("cookie"), SESSION_COOKIE),
      "session",
      Date.now(),
    )) !== null
  );
}

async function d1All(env: WebEnv, sql: string, ...binds: unknown[]): Promise<unknown[]> {
  if (!env.DB) return [];
  const r = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return r.results ?? [];
}

export async function handleWeb(request: Request, env: WebEnv, b: WebBrain): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!env.WEB_SESSION_SECRET) return json({ error: "web terminal not configured" }, 503);

  if (request.method === "POST" && path === "/api/login") {
    const body = (await request.json().catch(() => ({}))) as { t?: string };
    const p = await verifyToken(env.WEB_SESSION_SECRET, body.t, "login", Date.now());
    if (!p || !(await b.consumeOnce(`login:${p.n}`)))
      return json({ error: "link expired or already used" }, 401);
    const token = await signToken(env.WEB_SESSION_SECRET, {
      k: "session",
      exp: Date.now() + SESSION_TTL_MS,
      n: crypto.randomUUID(),
    });
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000) });
  }
  if (request.method === "POST" && path === "/api/logout") {
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  if (!(await session(request, env))) return json({ error: "sign in with /terminal in Discord" }, 401);

  if (request.method === "GET") {
    switch (path) {
      case "/api/state":
        return json(await b.status());
      case "/api/forecast": {
        const sym = (url.searchParams.get("symbol") ?? "BTC/USD").toUpperCase();
        if (!/^[A-Z]{1,6}(\/USD)?$/.test(sym)) return json({ error: "bad symbol" }, 400);
        return json(await b.forecast(sym));
      }
      case "/api/equity":
        return json(await b.equity(Number(url.searchParams.get("days") ?? 7)));
      case "/api/memory": {
        const [mem, report] = await Promise.all([
          b.memory(),
          d1All(
            env,
            "SELECT produced_at, payload_json FROM batch_results WHERE job = 'governor' AND skill_id = 'weekly-performance-digest' ORDER BY id DESC LIMIT 1",
          ),
        ]);
        return json({ ...(mem as object), scarFile: SCAR_TISSUE.rules.length, report: report[0] ?? null });
      }
      case "/api/court":
        return json(
          await d1All(
            env,
            `SELECT j.ts, j.payload_json, c.symbol, c.thesis_summary, c.bear_case_brief, c.proposed_conviction, c.models_used
             FROM journal j LEFT JOIN decision_contracts c ON c.contract_id = j.ref_id
             WHERE j.kind = 'COURT' ORDER BY j.seq DESC LIMIT 20`,
          ),
        );
      case "/api/rejections":
        return json(
          await d1All(
            env,
            "SELECT ts, stage, symbol, arena, reason_codes FROM rejections ORDER BY id DESC LIMIT 40",
          ),
        );
      case "/api/options":
        return json(
          await d1All(
            env,
            "SELECT trade_id, kind, ts, strategy, underlying, cash, max_loss_cents, pnl_cents, r, reason FROM options_shadow ORDER BY id DESC LIMIT 60",
          ),
        );
      default:
        return json({ error: "not found" }, 404);
    }
  }

  if (request.method === "POST" && path === "/api/command") {
    if (request.headers.get("x-cortex-web") !== "1")
      return json({ error: "missing x-cortex-web header" }, 400);
    const body = (await request.json().catch(() => ({}))) as { name?: string } & Record<string, unknown>;
    const by = `web:${env.OPERATOR_DISCORD_ID ?? "operator"}`;
    const r = await runCommand(b, String(body.name ?? ""), body as CommandArgs, by);
    return json(r, r.ok ? 200 : 400);
  }
  return json({ error: "not found" }, 404);
}

/** `/terminal` (Discord): a single-use login link for the operator. */
export async function loginLink(env: WebEnv, origin: string): Promise<string | null> {
  if (!env.WEB_SESSION_SECRET) return null;
  const t = await signToken(env.WEB_SESSION_SECRET, {
    k: "login",
    exp: Date.now() + 10 * 60_000,
    n: crypto.randomUUID(),
  });
  return `${origin}/#login=${t}`;
}
