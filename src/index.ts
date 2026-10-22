import type { Env } from "./env.ts";

export { AgentCortexDO } from "./cortex/AgentCortexDO.ts";

/**
 * Stateless edge router. Workers Free gives 10 ms CPU per request/cron: route only, never compute here.
 * Phase 0 routes: GET /health. Later: POST /discord/interactions, POST /ingest/batch, /api/*, /ws.
 */
function brain(env: Env) {
  return env.CORTEX.get(env.CORTEX.idFromName(env.CORTEX_DO_NAME));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const health = await brain(env).health();
      const stale = health.last_pulse_at === null || Date.now() - health.last_pulse_at > 15 * 60_000;
      return Response.json(health, { status: stale ? 503 : 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await brain(env).ensureAlarm();
  },
} satisfies ExportedHandler<Env>;
