import { MAX_BATCH_BYTES } from "./contracts/batch.ts";
import { hudMessage } from "./cortex/Brain.ts";
import {
  APPLICATION_COMMAND,
  accountOption,
  deferredEphemeral,
  ephemeral,
  followUp,
  type Interaction,
  InteractionSchema,
  MESSAGE_COMPONENT,
  option,
  PING,
  userId,
} from "./discord/interactions.ts";
import { verifyDiscordRequest } from "./discord/verify.ts";
import type { Env } from "./env.ts";
import { verifySignedBody } from "./lib/hmac.ts";
import { handleWeb, loginLink } from "./web/api.ts";
import { runCommand } from "./web/commands.ts";

export { AgentCortexDO, LabCortexDO } from "./cortex/AgentCortexDO.ts";

/**
 * Stateless edge router. Workers Free gives 10 ms CPU per request/cron: route only, never compute here.
 * Routes: GET /health, POST /discord/interactions.
 */
function brain(env: Env) {
  return env.CORTEX.get(env.CORTEX.idFromName(env.CORTEX_DO_NAME));
}

/** ADR-045: batch jobs the LAB brain also receives. */
const LAB_JOBS = new Set(["crypto-regime", "equity-posture", "kronos"]);

function labBrain(env: Env) {
  if (!env.CORTEX_LAB || !env.ALPACA_LAB_KEY_ID) return null;
  return env.CORTEX_LAB.get(env.CORTEX_LAB.idFromName(env.CORTEX_LAB_DO_NAME ?? "CORTEX-54-LAB"));
}

async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return new Response("Discord not configured", { status: 503 });
  const body = await request.text();
  const ok = await verifyDiscordRequest(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    body,
  );
  if (!ok) return new Response("Bad signature", { status: 401 });

  const parsed = InteractionSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return new Response("Bad interaction", { status: 400 });
  const i: Interaction = parsed.data;
  if (i.type === PING) return Response.json({ type: 1 });

  // Every command is operator-only. No operator configured → nobody can act.
  const who = userId(i);
  if (!env.OPERATOR_DISCORD_ID || who !== env.OPERATOR_DISCORD_ID) return ephemeral("⛔ Operator only.");
  const by = `discord:${who}`;
  const b = brain(env);

  if (i.type === MESSAGE_COMPONENT) return handleButton(i, env, ctx, b, by);
  if (i.type !== APPLICATION_COMMAND) return ephemeral("Unsupported interaction.");
  const name = i.data?.name;
  const account = accountOption(i);

  const args = {
    account: account ?? undefined,
    stop: option(i, "stop") === undefined ? undefined : Number(option(i, "stop")),
    confirm: option(i, "confirm") === undefined ? undefined : String(option(i, "confirm")),
    postmortem: option(i, "postmortem") === undefined ? undefined : String(option(i, "postmortem")),
    symbol: option(i, "symbol") === undefined ? undefined : String(option(i, "symbol")),
    thesis: option(i, "thesis") === undefined ? undefined : String(option(i, "thesis")),
  };

  switch (name) {
    case "status": {
      const msg = hudMessage(await b.status());
      return Response.json({ type: 4, data: { ...msg, flags: 64 } });
    }
    case "terminal": {
      const link = await loginLink(env, new URL(request.url).origin);
      return ephemeral(
        link ? `🖥️ Web terminal (single use, expires in 10 min): ${link}` : "Web terminal not configured.",
      );
    }
    case "court":
    case "roast":
    case "book":
    case "flatten": {
      // Slow paths: answer within 3 s, finish in the background, follow up (ADR-008).
      if (!i.token || !env.DISCORD_APP_ID) return ephemeral("Discord app not configured.");
      const appId = env.DISCORD_APP_ID;
      const token = i.token;
      ctx.waitUntil(
        runCommand(b, name, args, by).then(
          (r) => followUp(appId, token, r.message),
          (e) => followUp(appId, token, `Error: ${String(e)}`),
        ),
      );
      return deferredEphemeral();
    }
    default:
      return ephemeral((await runCommand(b, name ?? "", args, by)).message);
  }
}

/**
 * HUD buttons (spec §7.3, ADR-037). Same command runner as slash commands and the web terminal.
 * Flatten is two-step: the HUD button only offers a private confirm button (like the web panel's guard).
 */
async function handleButton(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  b: ReturnType<typeof brain>,
  by: string,
): Promise<Response> {
  const [action, account] = (i.data?.custom_id ?? "").split(":");
  if (account !== "PAPER" && account !== "LIVE") return ephemeral("Unknown control.");
  switch (action) {
    case "pause":
    case "resume":
      return ephemeral((await runCommand(b, action, { account }, by)).message);
    case "flatten":
      return Response.json({
        type: 4,
        data: {
          flags: 64,
          content: `⚠️ FLATTEN ALL on **${account}** sells every position at market and counts as an operator intervention (restarts the 30-day clock). Confirm?`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 4,
                  label: `Confirm flatten ${account}`,
                  custom_id: `flatten-confirm:${account}`,
                },
              ],
            },
          ],
        },
      });
    case "flatten-confirm": {
      if (!i.token || !env.DISCORD_APP_ID) return ephemeral("Discord app not configured.");
      const appId = env.DISCORD_APP_ID;
      const token = i.token;
      ctx.waitUntil(
        runCommand(b, "flatten", { account }, by).then(
          (r) => followUp(appId, token, r.message),
          (e) => followUp(appId, token, `Error: ${String(e)}`),
        ),
      );
      return deferredEphemeral();
    }
    default:
      return ephemeral("Unknown control.");
  }
}

/**
 * Read-only, HMAC-signed D1 export for the Governor (Phase 4). Paginates by rowid; whitelisted tables only.
 * Keeps the GitHub side free of Cloudflare credentials.
 */
const EXPORT_TABLES = new Set([
  "journal",
  "decision_contracts",
  "fills",
  "orders_log",
  "rejections",
  "rejection_grades",
  "triage_log",
  "llm_calls",
  "postmortems",
  "options_shadow",
]);

/** Operator fresh start for one account (ADR-038): HMAC-signed like ingest; never exposed in Discord or the web. */
async function adminReset(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_HMAC_SECRET) return new Response("not configured", { status: 503 });
  const body = await request.text();
  if (body.length > 500) return new Response("too large", { status: 413 });
  const ok = await verifySignedBody(
    env.INGEST_HMAC_SECRET,
    request.headers.get("x-cortex-signature"),
    request.headers.get("x-cortex-timestamp"),
    body,
  );
  if (!ok) return new Response("bad signature", { status: 401 });
  let q: { account?: unknown };
  try {
    q = JSON.parse(body) as typeof q;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (q.account !== "PAPER" && q.account !== "LIVE") return new Response("bad account", { status: 400 });
  // Audit W1-25: a captured signed request must not replay within its ±10 min window.
  if (!(await brain(env).consumeOnce(`admin-reset:${request.headers.get("x-cortex-signature")}`)))
    return new Response("replayed request", { status: 409 });
  const r = await brain(env).resetAccount(q.account, "operator:admin-reset");
  return Response.json(r, { status: r.ok ? 200 : 409 });
}

async function governorExport(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_HMAC_SECRET) return new Response("not configured", { status: 503 });
  const body = await request.text();
  if (body.length > 2_000) return new Response("too large", { status: 413 });
  const ok = await verifySignedBody(
    env.INGEST_HMAC_SECRET,
    request.headers.get("x-cortex-signature"),
    request.headers.get("x-cortex-timestamp"),
    body,
  );
  if (!ok) return new Response("bad signature", { status: 401 });
  let q: { table?: unknown; after?: unknown; limit?: unknown };
  try {
    q = JSON.parse(body) as typeof q;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const table = String(q.table ?? "");
  if (!EXPORT_TABLES.has(table)) return new Response("table not allowed", { status: 400 });
  const after = Number.isInteger(q.after) ? (q.after as number) : 0;
  const limit = Math.min(200, Math.max(1, Number.isInteger(q.limit) ? (q.limit as number) : 100));
  const res = await env.DB.prepare(
    `SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  )
    .bind(after, limit)
    .all();
  const rows = res.results ?? [];
  const last = rows.at(-1) as { _rid?: number } | undefined;
  return Response.json({ rows, next: last?._rid ?? null });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const b = brain(env);
      await b.ensureAlarm(); // sentinel ticks keep the heart armed even without a cron (ADR-021)
      await labBrain(env)?.ensureAlarm();
      const health = await b.health();
      const stale = health.last_pulse_at === null || Date.now() - health.last_pulse_at > 15 * 60_000;
      return Response.json(health, { status: stale ? 503 : 200 });
    }

    if (request.method === "POST" && url.pathname === "/ingest/batch") {
      if (!env.INGEST_HMAC_SECRET) return new Response("ingest not configured", { status: 503 });
      const body = await request.text();
      if (body.length > MAX_BATCH_BYTES) return new Response("too large", { status: 413 });
      const ok = await verifySignedBody(
        env.INGEST_HMAC_SECRET,
        request.headers.get("x-cortex-signature"),
        request.headers.get("x-cortex-timestamp"),
        body,
      );
      if (!ok) return new Response("bad signature", { status: 401 });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const receipt = await brain(env).ingest(parsed);
      // ADR-045: the LAB brain needs the same regime and Kronos data; it never sees world-intel or Governor batches.
      const job = (parsed as { job?: unknown } | null)?.job;
      const lab = labBrain(env);
      if (lab && receipt.ok && typeof job === "string" && LAB_JOBS.has(job))
        ctx.waitUntil(lab.ingest(parsed).catch(() => undefined));
      return Response.json(receipt, { status: receipt.ok ? 200 : 422 });
    }

    if (request.method === "POST" && url.pathname === "/admin/reset") {
      return adminReset(request, env);
    }

    if (request.method === "POST" && url.pathname === "/governor/export") {
      return governorExport(request, env);
    }

    if (request.method === "POST" && url.pathname === "/discord/interactions") {
      return handleInteraction(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/")) return handleWeb(request, env, brain(env));

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await brain(env).ensureAlarm();
    await labBrain(env)?.ensureAlarm();
  },
} satisfies ExportedHandler<Env>;
