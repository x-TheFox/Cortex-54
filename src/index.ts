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
  option,
  PING,
  userId,
} from "./discord/interactions.ts";
import { verifyDiscordRequest } from "./discord/verify.ts";
import type { Env } from "./env.ts";
import { verifySignedBody } from "./lib/hmac.ts";

export { AgentCortexDO } from "./cortex/AgentCortexDO.ts";

/**
 * Stateless edge router. Workers Free gives 10 ms CPU per request/cron: route only, never compute here.
 * Routes: GET /health, POST /discord/interactions.
 */
function brain(env: Env) {
  return env.CORTEX.get(env.CORTEX.idFromName(env.CORTEX_DO_NAME));
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

  if (i.type !== APPLICATION_COMMAND) return ephemeral("Unsupported interaction.");
  const name = i.data?.name;
  const account = accountOption(i);

  switch (name) {
    case "status": {
      const msg = hudMessage(await b.status());
      return Response.json({ type: 4, data: { ...msg, flags: 64 } });
    }
    case "pause":
      return ephemeral(account ? await b.pause(account, by) : "Pick an account.");
    case "resume":
      return ephemeral(account ? await b.resume(account, by) : "Pick an account.");
    case "dial": {
      const stop = Number(option(i, "stop"));
      const ratified = option(i, "confirm") === "RATIFY";
      return ephemeral(account ? await b.setDial(account, stop, by, ratified) : "Pick an account.");
    }
    case "unlock": {
      const pm = String(option(i, "postmortem") ?? "");
      return ephemeral(account ? await b.unlock(account, pm, by) : "Pick an account.");
    }
    case "court": {
      const symbol = String(option(i, "symbol") ?? "");
      if (!symbol || !i.token || !env.DISCORD_APP_ID)
        return ephemeral("Give a symbol, e.g. BTC/USD or NVDA.");
      const appId = env.DISCORD_APP_ID;
      const token = i.token;
      ctx.waitUntil(
        b.court(symbol, by).then(
          (msg) => followUp(appId, token, msg),
          (e) => followUp(appId, token, `Error: ${String(e)}`),
        ),
      );
      return deferredEphemeral();
    }
    case "flatten": {
      if (!account || !i.token || !env.DISCORD_APP_ID) return ephemeral("Pick an account.");
      const appId = env.DISCORD_APP_ID;
      const token = i.token;
      ctx.waitUntil(
        b.flatten(account, by).then(
          (msg) => followUp(appId, token, msg),
          (e) => followUp(appId, token, `Error: ${String(e)}`),
        ),
      );
      return deferredEphemeral();
    }
    default:
      return ephemeral(`Unknown command ${name ?? ""}`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const b = brain(env);
      await b.ensureAlarm(); // sentinel ticks keep the heart armed even without a cron (ADR-021)
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
      return Response.json(receipt, { status: receipt.ok ? 200 : 422 });
    }

    if (request.method === "POST" && url.pathname === "/discord/interactions") {
      return handleInteraction(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await brain(env).ensureAlarm();
  },
} satisfies ExportedHandler<Env>;
