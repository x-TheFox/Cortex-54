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
        min_length: 50,
        max_length: 1500,
      },
    ],
  },
  {
    name: "court",
    description: "Convene the bull-vs-bear court on a symbol now (all risk gates still apply; PAPER only)",
    options: [{ type: 3, name: "symbol", description: "e.g. BTC/USD, ETH/USD, NVDA, SPY", required: true }],
  },
  {
    name: "why",
    description: "What the robot did about a symbol and why (positions, contracts, refusals, exits)",
    options: [{ type: 3, name: "symbol", description: "e.g. BTC/USD, NVDA", required: true }],
  },
  {
    name: "roast",
    description: "Co-pilot: the court judges YOUR trade idea (never places an order)",
    options: [
      { type: 3, name: "symbol", description: "e.g. NVDA, SOL/USD", required: true },
      { type: 3, name: "thesis", description: "Your idea in a sentence", required: true },
    ],
  },
  { name: "book", description: "Book review now: R, age, correlation, beta, crash replay" },
  { name: "universe", description: "Hot-ported, watched and refused symbols in the dynamic universe" },
  { name: "terminal", description: "Get a single-use link to the web terminal (expires in 10 minutes)" },
] as const;
