import { z } from "zod";
import type { AccountId } from "../lib/ids.ts";

/** Minimal shape of the interactions we handle. Everything else is ignored. */
export const InteractionSchema = z.object({
  type: z.number().int(),
  id: z.string().optional(),
  token: z.string().optional(),
  application_id: z.string().optional(),
  member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  user: z.object({ id: z.string() }).optional(),
  data: z
    .object({
      name: z.string().optional(),
      custom_id: z.string().optional(),
      options: z
        .array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }))
        .optional(),
    })
    .optional(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const MESSAGE_COMPONENT = 3;

export const userId = (i: Interaction): string | null => i.member?.user.id ?? i.user?.id ?? null;

export function option(i: Interaction, name: string): string | number | boolean | undefined {
  return i.data?.options?.find((o) => o.name === name)?.value;
}

export function accountOption(i: Interaction): AccountId | null {
  const v = option(i, "account");
  return v === "PAPER" || v === "LIVE" ? v : null;
}

export const ephemeral = (content: string) =>
  Response.json({ type: 4, data: { content: content.slice(0, 1900), flags: 64 } });

export const deferredEphemeral = () => Response.json({ type: 5, data: { flags: 64 } });

export async function followUp(appId: string, token: string, content: string): Promise<void> {
  await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
  });
}
