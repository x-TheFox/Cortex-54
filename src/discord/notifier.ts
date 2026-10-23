import type { Fetcher } from "../broker/AlpacaClient.ts";

/** Channels the brain writes to (docs/ARCHITECTURE.md §10). IDs come from the DISCORD_CHANNELS var. */
export type ChannelKey =
  | "command_center"
  | "briefs"
  | "court"
  | "executions"
  | "alarms"
  | "world_intel"
  | "governor";

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface Button {
  type: 2;
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: Embed[];
  components?: { type: 1; components: Button[] }[];
}

export const COLORS = {
  green: 0x10b981,
  yellow: 0xf59e0b,
  orange: 0xf97316,
  red: 0xf43f5e,
  cyan: 0x38bdf8,
} as const;

export interface Notifier {
  /** Returns the created message id, or null when Discord isn't configured or the call failed. */
  post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null>;
  edit(channel: ChannelKey, messageId: string, msg: DiscordMessage): Promise<boolean>;
}

export class NullNotifier implements Notifier {
  readonly sent: { channel: ChannelKey; msg: DiscordMessage }[] = [];
  async post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null> {
    this.sent.push({ channel, msg });
    return null;
  }
  async edit(): Promise<boolean> {
    return false;
  }
}

/** Discord REST via bot token. Failures are swallowed (logged): telemetry must never break trading. */
export class DiscordNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly channels: Partial<Record<ChannelKey, string>>,
    private readonly guard: () => void,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  private async send(method: "POST" | "PATCH", path: string, msg: DiscordMessage): Promise<Response | null> {
    try {
      this.guard();
      return await this.fetcher(`https://discord.com/api/v10${path}`, {
        method,
        headers: { authorization: `Bot ${this.botToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...msg, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      console.warn("[discord] send failed", String(e));
      return null;
    }
  }

  async post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null> {
    const id = this.channels[channel];
    if (!id) return null;
    const res = await this.send("POST", `/channels/${id}/messages`, msg);
    if (!res?.ok) return null;
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  }

  async edit(channel: ChannelKey, messageId: string, msg: DiscordMessage): Promise<boolean> {
    const id = this.channels[channel];
    if (!id) return false;
    const res = await this.send("PATCH", `/channels/${id}/messages/${messageId}`, msg);
    return res?.ok ?? false;
  }
}

export function parseChannels(json: string | undefined): Partial<Record<ChannelKey, string>> {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<Record<ChannelKey, string>> = {};
    for (const k of [
      "command_center",
      "briefs",
      "court",
      "executions",
      "alarms",
      "world_intel",
      "governor",
    ] as const) {
      const v = raw[k];
      if (typeof v === "string" && /^\d{5,25}$/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
