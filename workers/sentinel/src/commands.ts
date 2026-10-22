/** Slash commands for the SENTINEL Discord app. Registered by scripts/register-commands.ts. */
export const SENTINEL_COMMANDS = [
  {
    name: "kill",
    description: "FLATTEN ALL: cancel every order and close every position on PAPER and LIVE",
    options: [{ type: 3, name: "reason", description: "Why", required: false }],
  },
  { name: "rearm", description: "Clear the kill flag so the brain may trade again" },
  { name: "sentinel", description: "Kill flag and brain heartbeat status" },
] as const;
