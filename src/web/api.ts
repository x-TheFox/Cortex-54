import { SCAR_TISSUE } from "../generated/config.ts";
import { type CommandArgs, type OperatorBrain, runCommand } from "./commands.ts";
import {
  cookieValue,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  signToken,
  type TokenPayload,
  verifyToken,
} from "./session.ts";

/**
 * Web terminal API (Phase 6, ADR-034). Routing only (10 ms CPU): every read is one DO RPC or one D1 query.
 * Mutations need the session cookie (HttpOnly, SameSite=Strict) and the `x-cortex-web: 1` header.
 */

/** The slice of Env the web API needs (kept narrow so it also runs under Node in tests). */
export interface WebEnv {
  WEB_SESSION_SECRET?: string | undefined;
  /** ADR-073: local mode keeps you signed in for 30 days on your own computer (cloud: 12 h) */
  SESSION_TTL_MS?: number | undefined;
  /** ADR-076: local phone access over plain HTTP on the user's Wi-Fi (cookie without Secure) */
  COOKIE_INSECURE?: boolean | undefined;
  /** audit F-A6-02: the request came over the Wi-Fi, not from this computer: destructive commands need a fresh sign-in */
  REMOTE_DEVICE?: boolean | undefined;
  OPERATOR_DISCORD_ID?: string | undefined;
  DB?:
    | { prepare(sql: string): { bind(...v: unknown[]): { all(): Promise<{ results?: unknown[] }> } } }
    | undefined;
}

/**
 * Settings the app can change (ADR-071). Only local mode implements this: there the brain owns its config file. A
 * cloud brain's keys are Worker secrets, changed by `savant deploy` from the desktop app, so the page says so.
 */
export interface WebSettings {
  view(): Promise<unknown>;
  /** BYOK model discovery: an empty key means "use the key already saved for this side" */
  models(q: { format: string; url: string; key: string; side: string }): Promise<unknown>;
  save(patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  discord(q: { token: string; guildId: string }): Promise<unknown>;
  /** models already running on this computer (Ollama, LM Studio) */
  detect(): Promise<unknown>;
  /** HEALTH: plain-word checks (same as `savant doctor`) */
  checks(): Promise<unknown>;
  /** a redacted support file (no secrets) the user can send for help */
  support(): Promise<Record<string, unknown>>;
  /** try an Alpaca key, Cloudflare AI, or one model for real */
  test(q: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  /** ADR-076: an encrypted backup (settings, journal, hot state; keys only when asked) */
  backup?(q: {
    passphrase: string;
    includeKeys: boolean;
  }): Promise<{ ok: boolean; message: string; file?: string; name?: string }>;
  /** ADR-076: restore a backup made on another computer (the brain restarts on it) */
  restore?(q: { file: string; passphrase: string }): Promise<{ ok: boolean; message: string }>;
  /** ADR-076: a one-time login link for a phone on this Wi-Fi (shown as a QR code) */
  pair?(): Promise<{ ok: boolean; message: string; url?: string }>;
  /** ADR-081: cap the paper account's borrowing at 1x at the broker */
  cashOnly?(account: "PAPER" | "LIVE"): Promise<{ ok: boolean; message: string }>;
  /** ADR-077: install a licence file */
  license?(q: { file?: string; key?: string; release?: boolean }): Promise<{ ok: boolean; message: string }>;
  /** ADR-087: accept the current terms, EULA and risk disclosure (first launch, and again when they change) */
  terms?(q: { accept: boolean }): Promise<{ ok: boolean; message: string }>;
  /** ADR-076: stop the service and delete everything Savant keeps on this computer */
  reset?(q: { confirm: string }): Promise<{ ok: boolean; message: string }>;
}

export interface WebBrain extends OperatorBrain {
  /** ADR-071: the app's feed (every card Discord would get) */
  feed(q: {
    channel: string | null;
    before: number | null;
    limit: number;
    exclude?: string[];
  }): Promise<unknown>;
  settings?: WebSettings | undefined;
  status(): Promise<unknown>;
  memory(): Promise<unknown>;
  equity(days: number): Promise<unknown>;
  forecast(symbol: string): Promise<unknown>;
  consumeOnce(id: string): Promise<boolean>;
  /** Audit W1-26: true once the session's nonce was revoked by /api/logout. */
  isRevoked(id: string): Promise<boolean>;
}

/** LIVE ratification from the app needs a session this young */
export const FRESH_LOGIN_MS = 10 * 60_000;
/** Commands a Wi-Fi device may send only on a fresh sign-in (audit F-A6-02). Pause stays one tap: it only stops entries. */
const LAN_FRESH_COMMANDS = new Set(["flatten", "kill", "rearm", "resume", "dial", "unlock", "ratify"]);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

async function session(request: Request, env: WebEnv): Promise<TokenPayload | null> {
  const secret = env.WEB_SESSION_SECRET;
  if (!secret) return null;
  return verifyToken(
    secret,
    cookieValue(request.headers.get("cookie"), SESSION_COOKIE),
    "session",
    Date.now(),
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
  const ttl = env.SESSION_TTL_MS ?? SESSION_TTL_MS;

  if (request.method === "POST" && path === "/api/login") {
    const body = (await request.json().catch(() => ({}))) as { t?: string };
    const p = await verifyToken(env.WEB_SESSION_SECRET, body.t, "login", Date.now());
    if (!p || !(await b.consumeOnce(`login:${p.n}`)))
      return json({ error: "link expired or already used" }, 401);
    const token = await signToken(env.WEB_SESSION_SECRET, {
      k: "session",
      exp: Date.now() + ttl,
      n: crypto.randomUUID(),
    });
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, ttl / 1000, !env.COOKIE_INSECURE) });
  }
  if (request.method === "POST" && path === "/api/logout") {
    // Audit W1-26: revoke the session server-side too, so a copied cookie stops working for commands.
    const p = await session(request, env);
    if (p) await b.consumeOnce(`revoked:${p.n}`);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0, !env.COOKIE_INSECURE) });
  }

  const sess = await session(request, env);
  if (!sess) return json({ error: "sign in with /terminal in Discord" }, 401);
  // audit F-A5-10: a signed-out cookie can't read either
  if (await b.isRevoked(`revoked:${sess.n}`)) return json({ error: "signed out; sign in again" }, 401);

  if (request.method === "GET") {
    switch (path) {
      case "/api/state":
        return json(await b.status());
      case "/api/feed": {
        const ch = url.searchParams.get("channel");
        if (ch !== null && !/^[a-z_]{1,20}$/.test(ch)) return json({ error: "bad channel" }, 400);
        return json(
          await b.feed({
            channel: ch,
            ...(ch ? {} : { exclude: ["terminal"] }), // ALL = everything but the raw agent log
            before: Number(url.searchParams.get("before")) || null,
            limit: Number(url.searchParams.get("limit")) || 50,
          }),
        );
      }
      case "/api/settings":
        return b.settings
          ? json(await b.settings.view())
          : json({
              managed: "cloud",
              message:
                "This brain runs in your cloud. Change its keys from the Savant app (Deploy), which pushes them as Worker secrets.",
            });
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
      case "/api/models":
        // ADR-072 model scoreboard: how each model in the pool did over the last 7 days
        return json(
          await d1All(
            env,
            `SELECT provider, model, COUNT(*) AS calls,
                    SUM(outcome = 'OK') AS ok, SUM(outcome = 'SCHEMA_FAIL') AS schema_fail,
                    SUM(outcome = 'RATE_LIMITED') AS rate_limited, SUM(outcome = 'TIMEOUT') AS timeouts,
                    SUM(outcome = 'ERROR') AS errors,
                    CAST(AVG(CASE WHEN outcome = 'OK' THEN latency_ms END) AS INTEGER) AS avg_ok_ms,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
             FROM llm_calls WHERE ts > ? AND outcome NOT IN ('UNAVAILABLE', 'SKIPPED_FAMILY')
             GROUP BY provider, model ORDER BY calls DESC LIMIT 60`,
            Date.now() - 7 * 86_400_000,
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

  if (request.method !== "POST") return json({ error: "not found" }, 404);
  // every mutation: the CSRF header and a session that was not signed out
  if (request.headers.get("x-cortex-web") !== "1") return json({ error: "missing x-cortex-web header" }, 400);
  if (await b.isRevoked(`revoked:${sess.n}`)) return json({ error: "signed out; sign in again" }, 401);

  if (path.startsWith("/api/settings/")) {
    if (!b.settings)
      return json(
        { ok: false, message: "Settings for a cloud brain are changed from the app (Deploy)." },
        404,
      );
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    switch (path) {
      case "/api/settings/models":
        return json(
          await b.settings.models({
            format: str("format"),
            url: str("url"),
            key: str("key"),
            side: str("side"),
          }),
        );
      case "/api/settings/save": {
        const r = await b.settings.save(body);
        return json(r, r.ok ? 200 : 400);
      }
      case "/api/settings/discord":
        return json(await b.settings.discord({ token: str("token"), guildId: str("guildId") }));
      case "/api/settings/detect":
        return json(await b.settings.detect());
      case "/api/settings/test":
        return json(await b.settings.test(body));
      case "/api/settings/checks":
        return json(await b.settings.checks());
      case "/api/settings/backup":
        return json(
          b.settings.backup
            ? await b.settings.backup({
                passphrase: str("passphrase"),
                includeKeys: body.includeKeys === true,
              })
            : { ok: false, message: "Not available here." },
        );
      case "/api/settings/restore":
        return json(
          b.settings.restore
            ? await b.settings.restore({ file: str("file"), passphrase: str("passphrase") })
            : { ok: false, message: "Not available here." },
        );
      case "/api/settings/cash-only":
        return json(
          b.settings.cashOnly
            ? await b.settings.cashOnly(body.account === "LIVE" ? "LIVE" : "PAPER")
            : { ok: false, message: "Not available here." },
        );
      case "/api/settings/license":
        return json(
          b.settings.license
            ? await b.settings.license({
                ...(str("file") ? { file: str("file") } : {}),
                ...(str("key") ? { key: str("key") } : {}),
                ...(body.release === true ? { release: true } : {}),
              })
            : { ok: false, message: "Not available here." },
        );
      case "/api/settings/terms":
        return json(
          b.settings.terms
            ? await b.settings.terms({ accept: body.accept === true })
            : { ok: false, message: "Not available here." },
        );
      case "/api/settings/pair":
        return json(
          b.settings.pair ? await b.settings.pair() : { ok: false, message: "Not available here." },
        );
      case "/api/settings/reset":
        return json(
          b.settings.reset
            ? await b.settings.reset({ confirm: str("confirm") })
            : { ok: false, message: "Not available here." },
        );
      case "/api/settings/support":
        return json(await b.settings.support(), 200, {
          "content-disposition": `attachment; filename="cortex-support-${new Date().toISOString().slice(0, 10)}.json"`,
        });
      default:
        return json({ error: "not found" }, 404);
    }
  }

  if (path === "/api/command") {
    const body = (await request.json().catch(() => ({}))) as { name?: string } & Record<string, unknown>;
    // Server-side guards (audit 2026-10-24): a stolen 12 h cookie must not be able to flatten in one POST or give
    // real money autonomy. Flatten needs an explicit confirmation; LIVE autonomy and LIVE unlocks need Discord,
    // where the operator's identity is signed by Discord rather than carried by a cookie.
    if (body.name === "flatten" && body.confirm !== "FLATTEN")
      return json({ ok: false, message: "Flatten needs confirm: FLATTEN." }, 400);
    // LIVE autonomy and LIVE unlocks from the app (ADR-071; Discord is optional now): only on a session signed in
    // within the last 10 minutes, so a copied long-lived cookie can't give real money autonomy.
    if (
      body.account === "LIVE" &&
      ((body.name === "dial" && Number(body.stop) > 0) || body.name === "unlock") &&
      sess.exp - ttl < Date.now() - FRESH_LOGIN_MS
    )
      return json(
        {
          ok: false,
          message:
            "LIVE autonomy and LIVE unlocks need a fresh sign-in (within 10 minutes). Sign in again, then retry.",
        },
        403,
      );
    // audit F-A6-02: over plain-HTTP Wi-Fi a 30-day cookie can be sniffed or copied; commands that close positions or
    // change autonomy need a sign-in from the last 10 minutes (pair again from the computer's QR)
    if (
      env.REMOTE_DEVICE &&
      LAN_FRESH_COMMANDS.has(String(body.name ?? "")) &&
      sess.exp - ttl < Date.now() - FRESH_LOGIN_MS
    )
      return json(
        {
          ok: false,
          message:
            "From a phone or another device, this needs a fresh sign-in. Scan the pairing code on your computer again, then retry.",
        },
        403,
      );
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
