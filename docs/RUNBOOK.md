# Runbook

## A. First-time setup (all free, no card)

1. **Cloudflare** — sign up, stay on Workers Free.
   ```bash
   pnpm install
   pnpm wrangler login
   pnpm wrangler d1 create cortex-journal      # paste database_id into wrangler.jsonc
   pnpm db:migrate:remote
   ```
   Create an API token (template "Edit Cloudflare Workers" + D1 edit) → GitHub secret
   `CLOUDFLARE_API_TOKEN`; account id → `CLOUDFLARE_ACCOUNT_ID`.
2. **Alpaca**
   - Paper: dashboard → Reset → equity **$54** → generate new paper keys.
   - Live: fund **$54**, confirm crypto is enabled for your state, request options Level 0/1 only (options
     stay paper). Generate live keys.
3. **Discord**
   - Create a server with channels: `command-center`, `pulse-and-briefs`, `bull-vs-bear-court`,
     `live-executions`, `world-intel-stream`, `governor-and-evolution`, `alarms-and-watchdog`,
     `agent-terminal`.
   - Create app **CORTEX** (bot, `applications.commands`) → interactions URL
     `https://cortex.<subdomain>.workers.dev/discord/interactions`.
   - Create app **SENTINEL** → interactions URL `https://cortex-sentinel.<subdomain>.workers.dev/discord/interactions`.
   - Create a webhook in `alarms-and-watchdog` (sentinel alerts) and `governor-and-evolution` (Actions).
   - Enable Developer Mode, copy your user ID → `OPERATOR_DISCORD_ID`.
4. **Free LLM keys** — Google AI Studio (Gemini), Groq, NVIDIA NIM (optional), OpenRouter (optional).
5. **Secrets**
   ```bash
   # cortex
   for s in ALPACA_PAPER_KEY_ID ALPACA_PAPER_SECRET ALPACA_LIVE_KEY_ID ALPACA_LIVE_SECRET \
            DISCORD_APP_ID DISCORD_PUBLIC_KEY DISCORD_BOT_TOKEN OPERATOR_DISCORD_ID \
            INGEST_HMAC_SECRET GEMINI_API_KEY GROQ_API_KEY NVIDIA_API_KEY OPENROUTER_API_KEY; do
     pnpm wrangler secret put $s; done
   # sentinel (its own copies — independence is the point)
   cd workers/sentinel && for s in ALPACA_PAPER_KEY_ID ALPACA_PAPER_SECRET ALPACA_LIVE_KEY_ID ALPACA_LIVE_SECRET \
            DISCORD_PUBLIC_KEY OPERATOR_DISCORD_ID DISCORD_ALARM_WEBHOOK; do pnpm wrangler secret put $s; done
   ```
   GitHub secrets for Actions: `INGEST_HMAC_SECRET`, `DISCORD_GOVERNOR_WEBHOOK`, data keys (FRED, Finnhub).

## B. Daily operator glance (Discord)
- `command-center`: rung, dial, breaker band, budget mode, last pulse age.
- `alarms-and-watchdog` should be quiet. Anything there is actionable.

## C. Incidents

| Symptom | Action |
|---|---|
| "missed heartbeat" from sentinel | check `cortex` logs (`wrangler tail`); broker stops protect positions; if >15 min, sentinel verifies stops |
| Budget mode REDUCE_ONLY | read which limit; usually waits until 00:00 UTC; investigate the spike |
| Reconciliation mismatch | system already REDUCE_ONLY; compare Alpaca dashboard vs `/status`; adopt or flatten orphan |
| RED breaker | everything flattened; fill the postmortem modal to unlock; Governor reviews next week |
| Anything feels wrong | SENTINEL `/kill` → cancels all orders and closes all positions on both accounts |

Manual last resort: Alpaca dashboard → "Close all positions" + "Cancel all orders".

## D. Drills
- Weekly (paper): `/kill` via SENTINEL, verify flat within 2 pulses, re-arm with `/dial`.
- Monthly: revoke paper keys to simulate auth failure; verify REDUCE_ONLY + alarm.
