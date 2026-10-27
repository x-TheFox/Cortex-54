/**
 * SENTINEL — independent watchdog + kill-switch (docs/ARCHITECTURE.md §12, constitution U5).
 * Shares no runtime code with `cortex` on purpose: if the brain's code is broken, this still works.
 *
 *  tick (cron every minute when a slot is free, otherwise POST /tick from .github/workflows/watchdog.yml):
 *   - brain heartbeat via /health; alert when stale (≤ ~5 alerts/hour, stateless de-dupe)
 *   - LIVE daily-loss check straight from Alpaca; breach → flatten LIVE + set the kill flag
 *   - brain dead for FLATTEN_ON_BRAIN_DEATH_MINUTES with LIVE positions → flatten LIVE + kill flag
 *  Discord (SENTINEL app, operator only): /kill [reason], /rearm, /sentinel
 *
 * The kill flag lives in KV key `killed`; the brain reads it every pulse and never writes it.
 */
import { verifyDiscordRequest } from "./verify.ts";

interface SentinelEnv {
  FLAGS: KVNamespace;
  /** Bearer secret for POST /tick (GitHub Actions watchdog when no cron slot is free, ADR-021). */
  SENTINEL_TICK_SECRET?: string;
  CORTEX_HEALTH_URL: string;
  STALE_ALERT_MINUTES: string;
  MAX_DAILY_LOSS_PCT: string;
  FLATTEN_ON_BRAIN_DEATH_MINUTES: string;
  DISCORD_ALARM_WEBHOOK?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APP_ID?: string;
  OPERATOR_DISCORD_ID?: string;
  ALPACA_PAPER_KEY_ID?: string;
  ALPACA_PAPER_SECRET?: string;
  ALPACA_LIVE_KEY_ID?: string;
  ALPACA_LIVE_SECRET?: string;
}

type Acct = "PAPER" | "LIVE";
const BASE: Record<Acct, string> = {
  PAPER: "https://paper-api.alpaca.markets",
  LIVE: "https://api.alpaca.markets",
};

function creds(env: SentinelEnv, a: Acct): { id: string; secret: string } | null {
  const id = a === "PAPER" ? env.ALPACA_PAPER_KEY_ID : env.ALPACA_LIVE_KEY_ID;
  const secret = a === "PAPER" ? env.ALPACA_PAPER_SECRET : env.ALPACA_LIVE_SECRET;
  return id && secret ? { id, secret } : null;
}

async function alpaca(env: SentinelEnv, a: Acct, method: string, path: string): Promise<Response> {
  const c = creds(env, a);
  if (!c) throw new Error(`${a} keys not configured`);
  return fetch(`${BASE[a]}${path}`, {
    method,
    headers: { "APCA-API-KEY-ID": c.id, "APCA-API-SECRET-KEY": c.secret },
    signal: AbortSignal.timeout(8_000),
  });
}

async function alert(env: SentinelEnv, content: string): Promise<void> {
  if (!env.DISCORD_ALARM_WEBHOOK) {
    console.warn("[sentinel]", content);
    return;
  }
  await fetch(env.DISCORD_ALARM_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
  }).catch(() => undefined);
}

/** Cancel all orders and close all positions on the given accounts, then set the kill flag. */
async function killAll(env: SentinelEnv, accounts: Acct[], by: string, reason: string): Promise<string> {
  await env.FLAGS.put("killed", JSON.stringify({ at: Date.now(), by, reason, accounts }));
  const results: string[] = [];
  for (const a of accounts) {
    if (!creds(env, a)) {
      results.push(`${a}: not configured`);
      continue;
    }
    try {
      const cancel = await alpaca(env, a, "DELETE", "/v2/orders");
      const close = await alpaca(env, a, "DELETE", "/v2/positions?cancel_orders=true");
      results.push(`${a}: cancel ${cancel.status}, close ${close.status}`);
    } catch (e) {
      results.push(`${a}: ERROR ${String(e)}`);
    }
  }
  const msg = `🛑 SENTINEL KILL by ${by}: ${reason}\n${results.join("\n")}`;
  await alert(env, msg);
  return msg;
}

async function brainAgeMinutes(
  env: SentinelEnv,
  now: number,
): Promise<{
  age: number;
  detail: string;
  discordFailStreak: number;
  nextAlarmAt: number | null | undefined;
  violations: Record<string, number>;
}> {
  const none = { discordFailStreak: 0, nextAlarmAt: undefined, violations: {} };
  if (!env.CORTEX_HEALTH_URL)
    return { age: Number.POSITIVE_INFINITY, detail: "CORTEX_HEALTH_URL not configured", ...none };
  try {
    // cache-busting query: the edge once served a minutes-old /health after a deploy (2026-10-24)
    const res = await fetch(`${env.CORTEX_HEALTH_URL}?t=${now}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { "cache-control": "no-cache" },
    });
    const body = (await res.json()) as {
      last_pulse_at: number | null;
      next_alarm_at?: number | null;
      discord_fail_streak?: number;
      policy_violations?: Record<string, number>;
    };
    const age = body.last_pulse_at === null ? Number.POSITIVE_INFINITY : (now - body.last_pulse_at) / 60_000;
    return {
      age,
      detail: `HTTP ${res.status}, last pulse ${Number.isFinite(age) ? age.toFixed(1) : "never"} min ago`,
      discordFailStreak: Number(body.discord_fail_streak ?? 0),
      nextAlarmAt: body.next_alarm_at,
      violations: body.policy_violations ?? {},
    };
  } catch (e) {
    return { age: Number.POSITIVE_INFINITY, detail: `health fetch failed: ${String(e)}`, ...none };
  }
}

/**
 * Converging flatten (audit W1-10): while the kill flag is set, check the accounts it names and re-flatten anything
 * still open, up to 5 attempts, then escalate every 15 minutes. A kill that did not flatten used to stay silent.
 */
async function enforceKill(env: SentinelEnv, raw: string, now: number): Promise<void> {
  let p: { at?: number; by?: string; reason?: string; accounts?: Acct[]; attempts?: number } = {};
  try {
    p = JSON.parse(raw);
  } catch {
    return; // a bare flag (older format): nothing to verify
  }
  const open: string[] = [];
  for (const a of p.accounts ?? []) {
    if (!creds(env, a)) continue;
    try {
      const [pos, ord] = await Promise.all([
        alpaca(env, a, "GET", "/v2/positions"),
        alpaca(env, a, "GET", "/v2/orders?status=open"),
      ]);
      const n =
        (pos.ok ? ((await pos.json()) as unknown[]).length : 0) +
        (ord.ok ? ((await ord.json()) as unknown[]).length : 0);
      if (n > 0) open.push(`${a}: ${n} open`);
    } catch (e) {
      open.push(`${a}: check failed ${String(e).slice(0, 80)}`);
    }
  }
  if (open.length === 0) return;
  const attempts = (p.attempts ?? 0) + 1;
  if (attempts <= 5) {
    await env.FLAGS.put("killed", JSON.stringify({ ...p, attempts }));
    for (const a of p.accounts ?? []) {
      if (!creds(env, a)) continue;
      await alpaca(env, a, "DELETE", "/v2/orders").catch(() => undefined);
      await alpaca(env, a, "DELETE", "/v2/positions?cancel_orders=true").catch(() => undefined);
    }
    await alert(
      env,
      `🛑 SENTINEL: kill still has exposure (${open.join("; ")}) — flatten retry ${attempts}/5`,
    );
  } else if (new Date(now).getUTCMinutes() % 15 === 0) {
    await alert(
      env,
      `🚨 SENTINEL KILL DIVERGENCE: still exposed after 5 flatten attempts (${open.join("; ")}). Close by hand.`,
    );
  }
}

async function cron(env: SentinelEnv, now: number): Promise<void> {
  const flag = await env.FLAGS.get("killed");
  const killed = flag !== null;
  if (flag !== null) await enforceKill(env, flag, now);

  // 1. Independent LIVE daily-loss check.
  if (!killed && creds(env, "LIVE")) {
    try {
      const res = await alpaca(env, "LIVE", "GET", "/v2/account");
      if (res.ok) {
        const acct = (await res.json()) as { equity: string; last_equity: string };
        const eq = Number(acct.equity);
        const last = Number(acct.last_equity);
        const maxLoss = Number(env.MAX_DAILY_LOSS_PCT) || 0.06;
        if (last > 0 && (last - eq) / last >= maxLoss) {
          await killAll(
            env,
            ["LIVE"],
            "sentinel",
            `LIVE daily loss ${(((last - eq) / last) * 100).toFixed(2)}% ≥ ${maxLoss * 100}%`,
          );
          return;
        }
      }
    } catch (e) {
      console.warn("[sentinel] live account check failed", String(e));
    }
  }

  // 2. Brain heartbeat.
  const { age, detail, discordFailStreak, nextAlarmAt, violations } = await brainAgeMinutes(env, now);
  const every30 = new Date(now).getUTCMinutes() % 30 === 0;
  // Audit W1-39: the brain checks constitution invariants over its own state; any violation is alerted from here.
  const broken = Object.entries(violations);
  if (broken.length > 0 && every30)
    await alert(
      env,
      `⚖️ SENTINEL: constitution invariant violated — ${broken.map(([k, n]) => `${k} ×${n}`).join(", ")}. Check the journal.`,
    );
  // Audit W1-14: an alarm that is not armed (or is far in the past) means the heart won't beat again by itself.
  if (nextAlarmAt !== undefined && (nextAlarmAt === null || nextAlarmAt < now - 10 * 60_000) && every30)
    await alert(
      env,
      `⏰ SENTINEL: the brain's next alarm is ${nextAlarmAt === null ? "not armed" : "overdue"}.`,
    );
  // The brain's own Discord path failing (revoked token, missing permission) can't report itself: say it here,
  // through the separate webhook (audit 2026-10-24: notifier failures were silent).
  if (discordFailStreak >= 5 && new Date(now).getUTCMinutes() % 30 === 0)
    await alert(
      env,
      `📵 SENTINEL: the brain's Discord messages are failing (${discordFailStreak} in a row). Check the bot token and channel permissions.`,
    );
  const staleAfter = Number(env.STALE_ALERT_MINUTES) || 3;
  if (age <= staleAfter) return;
  const minute = new Date(now).getUTCMinutes();
  if ((age >= staleAfter && age < staleAfter + 1) || minute % 15 === 0) {
    await alert(env, `🚨 SENTINEL: Savant heartbeat missing — ${detail}`);
  }

  // 3. Brain dead too long with LIVE exposure → flatten LIVE (fail closed, U6).
  const deathMinutes = Number(env.FLATTEN_ON_BRAIN_DEATH_MINUTES) || 60;
  if (!killed && age >= deathMinutes && creds(env, "LIVE")) {
    const res = await alpaca(env, "LIVE", "GET", "/v2/positions");
    const positions = res.ok ? ((await res.json()) as unknown[]) : [];
    if (positions.length > 0)
      await killAll(
        env,
        ["LIVE"],
        "sentinel",
        `brain silent ${detail}; LIVE has ${positions.length} position(s)`,
      );
  }
}

function ephemeral(content: string): Response {
  return Response.json({ type: 4, data: { content: content.slice(0, 1900), flags: 64 } });
}

async function interactions(request: Request, env: SentinelEnv, ctx: ExecutionContext): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return new Response("not configured", { status: 503 });
  const body = await request.text();
  const ok = await verifyDiscordRequest(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    body,
  );
  if (!ok) return new Response("Bad signature", { status: 401 });
  const i = JSON.parse(body) as {
    type: number;
    token?: string;
    member?: { user: { id: string } };
    user?: { id: string };
    data?: { name?: string; options?: { name: string; value: string }[] };
  };
  if (i.type === 1) return Response.json({ type: 1 });
  const who = i.member?.user.id ?? i.user?.id;
  if (!env.OPERATOR_DISCORD_ID || who !== env.OPERATOR_DISCORD_ID) return ephemeral("⛔ Operator only.");

  switch (i.data?.name) {
    case "kill": {
      const reason = i.data.options?.find((o) => o.name === "reason")?.value ?? "operator kill";
      if (!i.token || !env.DISCORD_APP_ID) return ephemeral("SENTINEL app id missing.");
      const appId = env.DISCORD_APP_ID;
      const token = i.token;
      ctx.waitUntil(
        killAll(env, ["PAPER", "LIVE"], `discord:${who}`, reason).then((msg) =>
          fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: msg.slice(0, 1900) }),
          }),
        ),
      );
      return Response.json({ type: 5, data: { flags: 64 } });
    }
    case "rearm": {
      const prev = await env.FLAGS.get("killed");
      await env.FLAGS.delete("killed");
      await alert(env, `🟢 SENTINEL re-armed by discord:${who}. Previous kill: ${prev ?? "none"}`);
      return ephemeral(
        "Kill flag cleared. The brain may enter new trades on its next pulse (respecting its own breakers and dial).",
      );
    }
    case "sentinel": {
      const flag = await env.FLAGS.get("killed");
      const { detail } = await brainAgeMinutes(env, Date.now());
      return ephemeral(`Kill flag: ${flag ?? "clear"}\nBrain: ${detail}`);
    }
    default:
      return ephemeral("Unknown command.");
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerOk(request: Request, env: SentinelEnv): boolean {
  const auth = request.headers.get("authorization") ?? "";
  return Boolean(env.SENTINEL_TICK_SECRET) && timingSafeEqual(auth, `Bearer ${env.SENTINEL_TICK_SECRET}`);
}

export default {
  async fetch(request: Request, env: SentinelEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/discord/interactions")
      return interactions(request, env, ctx);

    // Token-protected HTTP paths for the GitHub Actions watchdog and kill-switch (ADR-021, ADR-022).
    if (request.method === "POST" && ["/tick", "/kill", "/rearm"].includes(url.pathname)) {
      if (!bearerOk(request, env)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/tick") {
        await cron(env, Date.now());
        return new Response("ok");
      }
      if (url.pathname === "/kill") {
        const reason = (url.searchParams.get("reason") ?? "operator kill (http)").slice(0, 200);
        return new Response(await killAll(env, ["PAPER", "LIVE"], "http", reason));
      }
      const prev = await env.FLAGS.get("killed");
      await env.FLAGS.delete("killed");
      await alert(env, `🟢 SENTINEL re-armed via http. Previous kill: ${prev ?? "none"}`);
      return new Response("re-armed");
    }
    return new Response("cortex-sentinel", { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: SentinelEnv): Promise<void> {
    await cron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<SentinelEnv>;
