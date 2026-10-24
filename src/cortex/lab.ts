import type { Doctrine } from "../contracts/doctrine.ts";
import type { ChannelKey, DiscordMessage, Notifier } from "../discord/notifier.ts";

/**
 * LAB brain (ADR-045): a second instance of the same Brain on its own paper account and D1 journal. It forward-tests
 * the strategies in `doctrine.lab.strategies` with real paper fills, so PAPER's record (and its graduation clock)
 * only ever contains strategies that earned their place. Pure helpers; AgentCortexDO wires them.
 */

/** The doctrine as the LAB brain sees it: lab strategies ACTIVE on its (paper) account, every other one off. */
export function labDoctrine(d: Doctrine): Doctrine {
  const lab = new Set(d.lab.strategies);
  return {
    ...d,
    strategies: d.strategies.map((s) =>
      lab.has(s.id)
        ? { ...s, status: "ACTIVE" as const, accounts: ["PAPER"] }
        : { ...s, status: s.status === "ACTIVE" ? ("SHADOW" as const) : s.status },
    ),
  };
}

/**
 * LAB posts everything to #agent-terminal, tagged, and never touches the HUD or the operator-facing channels:
 * the command center stays about PAPER and LIVE.
 */
const DROPPED = new Set<ChannelKey>(["command_center", "briefs", "world_intel", "governor"]);

export class LabNotifier implements Notifier {
  constructor(private readonly inner: Notifier) {}
  private tag(msg: DiscordMessage): DiscordMessage {
    return {
      ...(msg.content ? { content: `🧪 **LAB** · ${msg.content}`.slice(0, 2000) } : {}),
      ...(msg.embeds
        ? {
            embeds: msg.embeds.map((e) => ({
              ...e,
              ...(e.title ? { title: `🧪 LAB · ${e.title}`.slice(0, 256) } : {}),
            })),
          }
        : {}),
    };
  }
  async post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null> {
    if (DROPPED.has(channel)) return null; // no second HUD; PAPER already posts briefs, world intel, Governor
    return this.inner.post("terminal", this.tag(msg));
  }
  async edit(): Promise<boolean> {
    return false;
  }
}
