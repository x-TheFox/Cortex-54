import type { Fetcher } from "../broker/AlpacaClient.ts";
import type { ChannelKey, DiscordMessage, Notifier } from "../discord/notifier.ts";

/**
 * Phone push alerts through ntfy (ADR-062; operator ask: "Android app for monitoring closely"). ntfy is free and open
 * source, needs no account, and has Android, iOS and desktop apps: subscribe to the topic and every alarm, fill/exit
 * and court ruling arrives as a notification. The topic name is the only secret (NTFY_TOPIC, long and random); the
 * pushes carry no keys or account numbers. Wraps the Discord notifier; a failed push never affects anything else.
 */

const PUSHED: Partial<Record<ChannelKey, { priority: number; tags: string; filter?: RegExp }>> = {
  alarms: { priority: 4, tags: "warning" },
  executions: { priority: 3, tags: "moneybag" },
  court: { priority: 3, tags: "scales", filter: /^(🔨 RULING|🔁 Re-underwriting)/ },
  governor: { priority: 2, tags: "dna", filter: /^(🧬 Governor report|📒 Book review)/ },
};

export function pushText(msg: DiscordMessage): { title: string; body: string } {
  const e = msg.embeds?.at(-1) ?? msg.embeds?.[0];
  const title = (e?.title ?? msg.content ?? "Savant").replace(/[*_`]/g, "").slice(0, 120);
  const body = [
    e?.description,
    ...(e?.fields ?? []).slice(-2).map((f) => `${f.name}: ${f.value}`),
    e ? msg.content : null,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join("\n")
    .replace(/\*\*|`|__/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .slice(0, 900);
  return { title, body: body || title };
}

export class PushNotifier implements Notifier {
  constructor(
    private readonly inner: Notifier,
    private readonly topicUrl: string,
    private readonly guard: () => void,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null> {
    const id = await this.inner.post(channel, msg);
    const rule = PUSHED[channel];
    if (rule) {
      const { title, body } = pushText(msg);
      const lastTitle = msg.embeds?.at(-1)?.title ?? msg.embeds?.[0]?.title ?? "";
      const firstTitle = msg.embeds?.[0]?.title ?? "";
      if (!rule.filter || rule.filter.test(lastTitle) || rule.filter.test(firstTitle)) {
        try {
          this.guard();
          await this.fetcher(this.topicUrl, {
            method: "POST",
            headers: {
              // ntfy reads these; non-ASCII titles must be RFC 2047-free, so emoji go in the body/tags instead
              title: title.replace(/[^\x20-\x7e]/g, "").trim() || "Savant",
              priority: String(rule.priority),
              tags: rule.tags,
            },
            body,
            signal: AbortSignal.timeout(4_000),
          });
        } catch {
          /* a push is a convenience; never let it fail the caller */
        }
      }
    }
    return id;
  }

  edit(channel: ChannelKey, messageId: string, msg: DiscordMessage): Promise<boolean> {
    return this.inner.edit(channel, messageId, msg);
  }
}

/** ntfy topic URL from env, or null (feature off). Topics must be long enough to be unguessable. */
export function ntfyUrl(topic: string | undefined, base: string | undefined): string | null {
  if (!topic || !/^[A-Za-z0-9_-]{16,64}$/.test(topic)) return null;
  const b = (base && /^https:\/\/[^/]+$/.test(base) ? base : "https://ntfy.sh").replace(/\/$/, "");
  return `${b}/${topic}`;
}
