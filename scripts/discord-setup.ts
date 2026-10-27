// Idempotent Discord bootstrap for the operator's cloud deployment (safe to re-run; reuses anything that exists).
//
//   node scripts/discord-setup.ts       (reads DISCORD_BOT_TOKEN, DISCORD_GUILD_ID from env)
//
// Same code as the app's Settings → Discord button (src/discord/setup.ts), plus: the sentinel alarm webhook (written
// to workers/sentinel/.dev.vars, never printed) and guild slash commands (the cloud worker has the interactions URL).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CORTEX_COMMANDS } from "../src/discord/commands.ts";
import { discordSetup } from "../src/discord/setup.ts";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("set DISCORD_BOT_TOKEN (and DISCORD_GUILD_ID if the bot is in several servers)");

const r = await discordSetup({
  token,
  guildId: process.env.DISCORD_GUILD_ID,
  commands: [...CORTEX_COMMANDS],
  webhook: true,
});
if (!r.ok) {
  console.error(r.message);
  if (r.needsInvite) console.error(`Invite: ${r.inviteUrl}`);
  process.exit(1);
}
console.log(`guild: ${r.guild.name}; created: ${r.created.join(", ") || "nothing (all existed)"}`);
const sentinelVars = "workers/sentinel/.dev.vars";
const current = existsSync(sentinelVars) ? readFileSync(sentinelVars, "utf8") : "";
if (r.webhookUrl && !current.includes("DISCORD_ALARM_WEBHOOK=")) {
  appendFileSync(sentinelVars, `DISCORD_ALARM_WEBHOOK=${r.webhookUrl}\n`, { mode: 0o600 });
  console.log("sentinel webhook saved to workers/sentinel/.dev.vars");
}
console.log(`registered ${r.commands ?? 0} guild commands`);
console.log(`OPERATOR_DISCORD_ID=${r.ownerId}`);
console.log(`DISCORD_CHANNELS=${JSON.stringify(r.channels)}`);
