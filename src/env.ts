import type { AgentCortexDO, LabCortexDO } from "./cortex/AgentCortexDO.ts";

/** Bindings and secrets for the `cortex` worker. Keep in sync with wrangler.jsonc and .dev.vars.example. */
export interface Env {
  CORTEX: DurableObjectNamespace<AgentCortexDO>;
  /** ADR-045: the LAB brain (forward-tests strategies on its own paper account) and its journal. */
  CORTEX_LAB?: DurableObjectNamespace<LabCortexDO>;
  DB: D1Database;
  DB_LAB: D1Database;
  AI: Ai;
  /** Shared with `sentinel`. Sentinel writes the `killed` key; the brain only reads it. */
  FLAGS: KVNamespace;

  CORTEX_ENV: string;
  CORTEX_DO_NAME: string;
  CORTEX_LAB_DO_NAME?: string;
  /** JSON: {"command_center":"<id>","briefs":"<id>","court":"<id>","executions":"<id>","alarms":"<id>"} */
  DISCORD_CHANNELS?: string;

  // Secrets (wrangler secret put). Each feature switches on only when its secrets exist.
  ALPACA_PAPER_KEY_ID?: string;
  ALPACA_PAPER_SECRET?: string;
  ALPACA_LIVE_KEY_ID?: string;
  ALPACA_LIVE_SECRET?: string;
  ALPACA_LAB_KEY_ID?: string;
  ALPACA_LAB_SECRET?: string;
  DISCORD_APP_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  OPERATOR_DISCORD_ID?: string;
  INGEST_HMAC_SECRET?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** ADR-072 model pool: the user's own endpoints + preferences as JSON (PoolConfigSchema). Set by `cortex deploy`. */
  LLM_POOL?: string;
  /** "owner/name" of this repo; the brain dispatches its batch workflows there (ADR-032). */
  GITHUB_REPO?: string;
  /** Fine-grained token, this repo only, Actions: read and write. Absent → GitHub's own crons only. */
  GH_DISPATCH_TOKEN?: string;
  /** ADR-065: "queue" = research jobs wait for a linked CORTEX desktop runner instead of GitHub Actions. */
  RUNNER_MODE?: string;
  /** HMAC key for web-terminal login links and session cookies (ADR-034). */
  WEB_SESSION_SECRET?: string;
  /** ADR-068 community hub (optional): hub URL, the agent's Ed25519 key, display name, publish flag, followed agents */
  HUB_URL?: string;
  HUB_AGENT_KEY?: string;
  HUB_AGENT_NAME?: string;
  HUB_PUBLISH?: string;
  HUB_FOLLOW?: string;
  /** ADR-062: ntfy push alerts (topic = 16–64 url-safe chars; optional self-hosted https base). Absent → off. */
  NTFY_TOPIC?: string;
  NTFY_URL?: string;
  /** ADR-062: read-only bearer token for /pill (desktop widgets). Absent → /pill returns 503. */
  PILL_TOKEN?: string;
  /** Static web terminal (public/). */
  ASSETS?: Fetcher;
}
