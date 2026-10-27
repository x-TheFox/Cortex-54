import type { ChannelKey } from "./notifier.ts";

/**
 * Discord auto-setup (ADR-071). Discord is an optional add-on to the app: the user pastes a bot token, and this
 * creates (or reuses) a private CORTEX-54 category with one channel per feed, plus an alarm webhook. Idempotent: safe
 * to re-run. When the bot is not in any server yet, it returns the invite link instead. Slash commands are registered
 * only when asked (they need a public interactions URL, which only the cloud worker has).
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://discord.com/api/v10";

export const CHANNELS: readonly { key: ChannelKey; name: string; topic: string }[] = [
  { key: "command_center", name: "🎛️-command-center", topic: "Live HUD (edited in place)" },
  {
    key: "briefs",
    name: "📡-pulse-and-briefs",
    topic: "Posture cards, daily journal hash anchors, weekly reports",
  },
  {
    key: "court",
    name: "⚖️-bull-vs-bear-court",
    topic: "Court sessions, decision contracts, position reviews",
  },
  { key: "executions", name: "📈-live-executions", topic: "Fills, exits, P&L" },
  { key: "world_intel", name: "📰-world-intel-stream", topic: "Catalysts that cleared triage" },
  { key: "governor", name: "🧬-governor-and-evolution", topic: "Governor reports, book reviews, proposals" },
  {
    key: "alarms",
    name: "🚨-alarms-and-watchdog",
    topic: "Breakers, reconciliation problems, watchdog alerts",
  },
  { key: "terminal", name: "💬-agent-terminal", topic: "The agent's running commentary" },
];

const P = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_WEBHOOKS: 1n << 29n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_CHANNELS: 1n << 4n,
};
const BOT_ALLOW =
  P.VIEW_CHANNEL |
  P.SEND_MESSAGES |
  P.EMBED_LINKS |
  P.ATTACH_FILES |
  P.READ_MESSAGE_HISTORY |
  P.MANAGE_MESSAGES |
  P.MANAGE_WEBHOOKS;
const OWNER_ALLOW = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.USE_APPLICATION_COMMANDS;
/** what the invite asks for: enough to build the category and post into it */
export const INVITE_PERMISSIONS = (BOT_ALLOW | P.MANAGE_CHANNELS).toString();

export function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

export type SetupResult =
  | {
      ok: true;
      guild: { id: string; name: string };
      ownerId: string;
      channels: Partial<Record<ChannelKey, string>>;
      created: string[];
      webhookUrl: string | null;
      commands: number | null;
    }
  | {
      ok: false;
      needsInvite: true;
      inviteUrl: string;
      message: string;
      guilds?: { id: string; name: string }[];
    }
  | { ok: false; needsInvite?: false; message: string };

export async function discordSetup(o: {
  token: string;
  guildId?: string | undefined;
  /** register these slash commands in the guild (cloud only: they need a public interactions URL) */
  commands?: unknown[] | undefined;
  /** create the alarm webhook (the watchdog's independent path) */
  webhook?: boolean;
  fetcher?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SetupResult> {
  const f = o.fetcher ?? ((u, i) => fetch(u, i));
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await f(`${API}${path}`, {
        method,
        headers: { authorization: `Bot ${o.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) {
        const wait = Number(
          ((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1,
        );
        await sleep(Math.ceil(wait * 1000) + 100);
        continue;
      }
      const text = await res.text();
      if (!res.ok)
        throw new DiscordError(res.status, `${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : null) as T;
    }
    throw new DiscordError(429, `${method} ${path}: rate limited`);
  }

  let me: { id: string };
  try {
    me = await api<{ id: string }>("GET", "/users/@me");
  } catch (e) {
    if (e instanceof DiscordError && e.status === 401)
      return {
        ok: false,
        message: "Discord rejected the bot token (401). Copy it again from the Developer Portal → Bot.",
      };
    throw e;
  }
  const app = await api<{ id: string }>("GET", "/oauth2/applications/@me").catch(() => ({ id: me.id }));
  let guildId = o.guildId?.trim();
  if (!guildId) {
    const guilds = await api<{ id: string; name: string }[]>("GET", "/users/@me/guilds");
    if (guilds.length === 0)
      return {
        ok: false,
        needsInvite: true,
        inviteUrl: inviteUrl(app.id),
        message:
          "The bot is not in a server yet. Open the invite link, add it to your server, then press Connect again.",
      };
    if (guilds.length > 1)
      return {
        ok: false,
        needsInvite: true,
        inviteUrl: inviteUrl(app.id),
        guilds: guilds.map((g) => ({ id: g.id, name: g.name })),
        message: "The bot is in several servers. Pick one.",
      };
    guildId = (guilds[0] as { id: string }).id;
  }
  const guild = await api<{ id: string; name: string; owner_id: string }>("GET", `/guilds/${guildId}`);
  const overwrites = [
    { id: guild.id, type: 0, allow: "0", deny: P.VIEW_CHANNEL.toString() }, // @everyone role id == guild id
    { id: me.id, type: 1, allow: BOT_ALLOW.toString(), deny: "0" },
    { id: guild.owner_id, type: 1, allow: OWNER_ALLOW.toString(), deny: "0" },
  ];
  type Channel = { id: string; name: string; type: number; parent_id?: string | null };
  const existing = await api<Channel[]>("GET", `/guilds/${guild.id}/channels`);
  const created: string[] = [];
  let category = existing.find((c) => c.type === 4 && c.name.toLowerCase() === "cortex-54");
  if (!category) {
    category = await api<Channel>("POST", `/guilds/${guild.id}/channels`, {
      name: "CORTEX-54",
      type: 4,
      permission_overwrites: overwrites,
    });
    created.push("CORTEX-54");
  }
  const channels: Partial<Record<ChannelKey, string>> = {};
  for (const ch of CHANNELS) {
    let c = existing.find((x) => x.type === 0 && x.name === ch.name);
    if (!c) {
      c = await api<Channel>("POST", `/guilds/${guild.id}/channels`, {
        name: ch.name,
        type: 0,
        topic: ch.topic,
        parent_id: category.id,
        permission_overwrites: overwrites,
      });
      created.push(`#${ch.name}`);
    }
    channels[ch.key] = c.id;
  }
  let webhookUrl: string | null = null;
  if (o.webhook && channels.alarms) {
    const hooks = await api<{ id: string; name: string; token?: string }[]>(
      "GET",
      `/channels/${channels.alarms}/webhooks`,
    );
    let hook = hooks.find((h) => h.name === "CORTEX Sentinel" && h.token);
    if (!hook) hook = await api("POST", `/channels/${channels.alarms}/webhooks`, { name: "CORTEX Sentinel" });
    if (hook?.token) webhookUrl = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
  }
  let commands: number | null = null;
  if (o.commands?.length)
    commands = (
      await api<unknown[]>("PUT", `/applications/${app.id}/guilds/${guild.id}/commands`, o.commands)
    ).length;
  return {
    ok: true,
    guild: { id: guild.id, name: guild.name },
    ownerId: guild.owner_id,
    channels,
    created,
    webhookUrl,
    commands,
  };
}

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
