import type { AgentCortexDO } from "./cortex/AgentCortexDO.ts";

/** Bindings and secrets for the `cortex` worker. Keep in sync with wrangler.jsonc and .dev.vars.example. */
export interface Env {
  CORTEX: DurableObjectNamespace<AgentCortexDO>;
  DB: D1Database;
  AI: Ai;
  /** Shared with `sentinel`. Sentinel writes the `killed` key; the brain only reads it. */
  FLAGS: KVNamespace;

  CORTEX_ENV: string;
  CORTEX_DO_NAME: string;
  /** JSON: {"command_center":"<id>","briefs":"<id>","court":"<id>","executions":"<id>","alarms":"<id>"} */
  DISCORD_CHANNELS?: string;

  // Secrets (wrangler secret put). Each feature switches on only when its secrets exist.
  ALPACA_PAPER_KEY_ID?: string;
  ALPACA_PAPER_SECRET?: string;
  ALPACA_LIVE_KEY_ID?: string;
  ALPACA_LIVE_SECRET?: string;
  DISCORD_APP_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  OPERATOR_DISCORD_ID?: string;
  INGEST_HMAC_SECRET?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}
