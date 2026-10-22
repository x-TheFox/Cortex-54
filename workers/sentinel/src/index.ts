/**
 * SENTINEL (Phase 0): heartbeat watchdog.
 * Phase 1 adds: SENTINEL Discord app `/kill` (Ed25519-verified, operator-only) → cancel all orders + close all
 * positions on both Alpaca accounts; independent LIVE daily-loss check; stop verification when the brain is down.
 *
 * Stateless on purpose (no KV writes). Alert de-duplication: while stale, alert only on minutes divisible by 15
 * plus the first stale minute, so at most ~5 alerts/hour.
 */
interface SentinelEnv {
  CORTEX_HEALTH_URL: string;
  STALE_ALERT_MINUTES: string;
  DISCORD_ALARM_WEBHOOK?: string;
}

interface HealthBody {
  last_pulse_at: number | null;
}

async function checkBrain(
  env: SentinelEnv,
  now: number,
): Promise<{ ok: boolean; detail: string; ageMin: number }> {
  if (!env.CORTEX_HEALTH_URL)
    return { ok: false, detail: "CORTEX_HEALTH_URL not configured", ageMin: Infinity };
  try {
    const res = await fetch(env.CORTEX_HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as HealthBody;
    const ageMin = body.last_pulse_at === null ? Infinity : (now - body.last_pulse_at) / 60_000;
    const limit = Number(env.STALE_ALERT_MINUTES) || 3;
    return {
      ok: ageMin <= limit,
      detail: `HTTP ${res.status}, last pulse ${ageMin.toFixed(1)} min ago`,
      ageMin,
    };
  } catch (err) {
    return { ok: false, detail: `health fetch failed: ${String(err)}`, ageMin: Infinity };
  }
}

async function alert(env: SentinelEnv, content: string): Promise<void> {
  if (!env.DISCORD_ALARM_WEBHOOK) {
    console.warn("[sentinel] no DISCORD_ALARM_WEBHOOK; alert:", content);
    return;
  }
  await fetch(env.DISCORD_ALARM_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
  });
}

export default {
  async fetch(): Promise<Response> {
    return new Response("cortex-sentinel", { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: SentinelEnv): Promise<void> {
    const now = controller.scheduledTime;
    const { ok, detail, ageMin } = await checkBrain(env, now);
    if (ok) return;
    const minute = new Date(now).getUTCMinutes();
    const limit = Number(env.STALE_ALERT_MINUTES) || 3;
    const firstStaleMinute = ageMin >= limit && ageMin < limit + 1;
    if (firstStaleMinute || minute % 15 === 0) {
      await alert(env, `🚨 SENTINEL: CORTEX heartbeat missing — ${detail}`);
    }
  },
} satisfies ExportedHandler<SentinelEnv>;
