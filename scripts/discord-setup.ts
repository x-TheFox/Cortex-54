// Idempotent Discord bootstrap for the CORTEX app (safe to re-run; reuses anything that already exists).
//
//   node scripts/discord-setup.ts       (reads DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID from env)
//
// 1. private category "CORTEX-54" (@everyone denied; bot + guild owner allowed) with the channels from
//    docs/ARCHITECTURE.md §10
// 2. a webhook in the alarms channel for the sentinel (written to workers/sentinel/.dev.vars, never printed)
// 3. guild-scoped slash commands for the CORTEX app (guild scope is instant; global can take an hour)
// 4. prints DISCORD_CHANNELS JSON and OPERATOR_DISCORD_ID (the guild owner)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CORTEX_COMMANDS } from "../src/discord/commands.ts";

const API = "https://discord.com/api/v10";
const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !appId || !guildId) throw new Error("set DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429) {
      const wait = Number(((await res.json()) as { retry_after?: number }).retry_after ?? 1);
      await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 100));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }
  throw new Error(`${method} ${path}: rate limited`);
}

const P = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_WEBHOOKS: 1n << 29n,
};
const botAllow =
  P.VIEW_CHANNEL |
  P.SEND_MESSAGES |
  P.EMBED_LINKS |
  P.ATTACH_FILES |
  P.READ_MESSAGE_HISTORY |
  P.MANAGE_MESSAGES |
  P.MANAGE_WEBHOOKS;
const ownerAllow = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.USE_APPLICATION_COMMANDS;

/** key = DISCORD_CHANNELS key the brain uses; name = channel name; topic shown in Discord. */
const CHANNELS = [
  {
    key: "command_center",
    name: "🎛️-command-center",
    topic: "Live HUD (edited in place). /status /pause /resume /dial /flatten /unlock",
  },
  {
    key: "briefs",
    name: "📡-pulse-and-briefs",
    topic: "Posture cards, daily journal hash anchors, weekly report cards",
  },
  {
    key: "court",
    name: "⚖️-bull-vs-bear-court",
    topic: "Decision contracts awaiting approval (Approve / Veto)",
  },
  { key: "executions", name: "📈-live-executions", topic: "Fills, exits, P&L" },
  { key: "world_intel", name: "📰-world-intel-stream", topic: "Catalysts that cleared triage (Phase 3)" },
  {
    key: "governor",
    name: "🧬-governor-and-evolution",
    topic: "Governor proposals and doctrine PRs (Phase 4)",
  },
  {
    key: "alarms",
    name: "🚨-alarms-and-watchdog",
    topic: "Breakers, reconciliation problems, sentinel alerts",
  },
  { key: "terminal", name: "💬-agent-terminal", topic: "Ask the agent (later phase)" },
] as const;

type Channel = { id: string; name: string; type: number; parent_id?: string | null };

const guild = await api<{ id: string; name: string; owner_id: string }>("GET", `/guilds/${guildId}`);
const me = await api<{ id: string }>("GET", "/users/@me");
console.log(`guild: ${guild.name}; bot ${me.id}`);

const overwrites = [
  { id: guild.id, type: 0, allow: "0", deny: P.VIEW_CHANNEL.toString() }, // @everyone role id == guild id
  { id: me.id, type: 1, allow: botAllow.toString(), deny: "0" },
  { id: guild.owner_id, type: 1, allow: ownerAllow.toString(), deny: "0" },
];

const existing = await api<Channel[]>("GET", `/guilds/${guildId}/channels`);
let category = existing.find((c) => c.type === 4 && c.name.toLowerCase() === "cortex-54");
if (!category) {
  category = await api<Channel>("POST", `/guilds/${guildId}/channels`, {
    name: "CORTEX-54",
    type: 4,
    permission_overwrites: overwrites,
  });
  console.log("created category CORTEX-54");
}

const ids: Record<string, string> = {};
for (const ch of CHANNELS) {
  let c = existing.find((x) => x.type === 0 && x.name === ch.name);
  if (!c) {
    c = await api<Channel>("POST", `/guilds/${guildId}/channels`, {
      name: ch.name,
      type: 0,
      topic: ch.topic,
      parent_id: category.id,
      permission_overwrites: overwrites,
    });
    console.log(`created #${c.name}`);
  }
  ids[ch.key] = c.id;
}

// Sentinel alarm webhook. It is a secret: written to a gitignored file, never printed.
const alarms = ids.alarms as string;
const hooks = await api<{ id: string; name: string; token?: string }[]>(
  "GET",
  `/channels/${alarms}/webhooks`,
);
let hook = hooks.find((h) => h.name === "CORTEX Sentinel" && h.token);
if (!hook) hook = await api("POST", `/channels/${alarms}/webhooks`, { name: "CORTEX Sentinel" });
const sentinelVars = "workers/sentinel/.dev.vars";
const current = existsSync(sentinelVars) ? readFileSync(sentinelVars, "utf8") : "";
if (!current.includes("DISCORD_ALARM_WEBHOOK=")) {
  appendFileSync(
    sentinelVars,
    `DISCORD_ALARM_WEBHOOK=https://discord.com/api/webhooks/${hook?.id}/${hook?.token}\n`,
    {
      mode: 0o600,
    },
  );
  console.log("sentinel webhook saved to workers/sentinel/.dev.vars");
}

const registered = await api<unknown[]>(
  "PUT",
  `/applications/${appId}/guilds/${guildId}/commands`,
  CORTEX_COMMANDS,
);
console.log(`registered ${registered.length} guild commands`);

console.log(`OPERATOR_DISCORD_ID=${guild.owner_id}`);
console.log(`DISCORD_CHANNELS=${JSON.stringify(ids)}`);
