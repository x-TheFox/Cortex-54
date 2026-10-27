import type { SqlLike } from "../cortex/store.ts";
import type { ChannelKey, DiscordMessage, Notifier } from "../discord/notifier.ts";

/**
 * The app's feed (ADR-071). Every card the brain posts is kept in the hot store, so the web app shows the same alerts,
 * court sessions, briefs and reports whether or not Discord is set up. Discord (when configured) receives the same
 * message as before; the inbox never depends on it. The command-center HUD is not kept: the app's cockpit is the live
 * version of it. Bounded: the newest `keep` rows and at most `maxAgeMs` old.
 */
export class InboxNotifier implements Notifier {
  private writes = 0;

  constructor(
    private readonly sql: SqlLike,
    private readonly inner: Notifier,
    private readonly now: () => number,
    private readonly keep = 3000,
    private readonly maxAgeMs = 30 * 86_400_000,
  ) {}

  async post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null> {
    if (channel !== "command_center") {
      try {
        const { components: _buttons, ...rest } = msg; // Discord buttons don't work in the app; its own controls do
        this.sql.exec(
          "INSERT INTO inbox (ts, channel, msg_json) VALUES (?, ?, ?)",
          this.now(),
          channel,
          JSON.stringify(rest),
        );
        if (++this.writes % 50 === 1) this.prune();
      } catch (e) {
        console.error(`[inbox] ${String(e).slice(0, 200)}`); // the feed must never break trading
      }
    }
    return this.inner.post(channel, msg);
  }

  edit(channel: ChannelKey, messageId: string, msg: DiscordMessage): Promise<boolean> {
    return this.inner.edit(channel, messageId, msg);
  }

  private prune(): void {
    this.sql.exec("DELETE FROM inbox WHERE ts < ?", this.now() - this.maxAgeMs);
    this.sql.exec(
      "DELETE FROM inbox WHERE id <= (SELECT id FROM inbox ORDER BY id DESC LIMIT 1 OFFSET ?)",
      this.keep,
    );
  }
}

export interface FeedItem {
  id: number;
  ts: number;
  channel: string;
  msg: DiscordMessage;
}

/** Newest first; `before` pages back; `channel` filters; no channel = everything but the agent log (noise for most). */
export function readFeed(
  sql: SqlLike,
  opts: { channel?: string | null; before?: number | null; limit?: number; exclude?: string[] } = {},
): FeedItem[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.channel) {
    where.push("channel = ?");
    args.push(opts.channel);
  }
  for (const x of opts.exclude ?? []) {
    where.push("channel != ?");
    args.push(x);
  }
  if (opts.before) {
    where.push("id < ?");
    args.push(opts.before);
  }
  const rows = sql.exec<{ id: number; ts: number; channel: string; msg_json: string }>(
    `SELECT id, ts, channel, msg_json FROM inbox ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC LIMIT ?`,
    ...args,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    channel: r.channel,
    msg: JSON.parse(r.msg_json) as DiscordMessage,
  }));
}
