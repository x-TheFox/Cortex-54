/** Slash commands for the CORTEX Discord app. Registered by scripts/register-commands.ts. */
const account = {
  type: 3,
  name: "account",
  description: "Which account",
  required: true,
  choices: [
    { name: "PAPER", value: "PAPER" },
    { name: "LIVE", value: "LIVE" },
  ],
};

export const CORTEX_COMMANDS = [
  { name: "status", description: "Equity, breakers, dial, positions and budget for both accounts" },
  { name: "pause", description: "Stop new entries on an account (exits still run)", options: [account] },
  { name: "resume", description: "Allow new entries again (not after a RED lock)", options: [account] },
  {
    name: "dial",
    description: "Autonomy dial: PAPER 0 shadow / 2 autonomous; LIVE 0 dormant / 3 autonomous (needs RATIFY)",
    options: [
      account,
      { type: 4, name: "stop", description: "0-4", required: true, min_value: 0, max_value: 4 },
      { type: 3, name: "confirm", description: "Type RATIFY to let LIVE trade real money", required: false },
    ],
  },
  {
    name: "flatten",
    description: "Cancel entries and exit every position on an account",
    options: [account],
  },
  {
    name: "unlock",
    description: "Unlock an account after a RED breaker (needs a written postmortem)",
    options: [
      account,
      {
        type: 3,
        name: "postmortem",
        description: "What happened and what changes (≥50 chars)",
        required: true,
      },
    ],
  },
] as const;
