// Registers slash commands for both Discord apps (global commands; may take a minute to appear).
//   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… SENTINEL_APP_ID=… SENTINEL_BOT_TOKEN=… node scripts/register-commands.ts
// Either pair may be omitted to register only the other app.
import { CORTEX_COMMANDS } from "../src/discord/commands.ts";
import { SENTINEL_COMMANDS } from "../workers/sentinel/src/commands.ts";

async function register(
  label: string,
  appId: string | undefined,
  token: string | undefined,
  commands: unknown,
): Promise<void> {
  if (!appId || !token) {
    console.log(`${label}: skipped (app id or bot token not set)`);
    return;
  }
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: ${res.status} ${text}`);
  console.log(`${label}: registered ${(JSON.parse(text) as unknown[]).length} commands`);
}

await register("Savant", process.env.DISCORD_APP_ID, process.env.DISCORD_BOT_TOKEN, CORTEX_COMMANDS);
await register("SENTINEL", process.env.SENTINEL_APP_ID, process.env.SENTINEL_BOT_TOKEN, SENTINEL_COMMANDS);
