# Runbook

## A. First-time setup (all free, no card)

1. **Cloudflare** — sign up, stay on Workers Free.
   ```bash
   pnpm install
   pnpm wrangler login
   pnpm wrangler d1 create cortex-journal      # paste database_id into wrangler.jsonc
   pnpm wrangler kv namespace create FLAGS     # paste id into wrangler.jsonc AND workers/sentinel/wrangler.jsonc
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
   - Copy channel IDs into `DISCORD_CHANNELS` in `wrangler.jsonc`:
     `{"command_center":"…","briefs":"…","court":"…","executions":"…","alarms":"…"}` (IDs are not secret).
   - Invite both bots to the server (scope `bot` + `applications.commands`, permission: Send Messages,
     Embed Links, Read Message History).
   - Register slash commands:
     ```bash
     DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… SENTINEL_APP_ID=… SENTINEL_BOT_TOKEN=… pnpm discord:register
     ```
   - Set `CORTEX_HEALTH_URL` in `workers/sentinel/wrangler.jsonc` to `https://cortex.<subdomain>.workers.dev/health`.
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
            DISCORD_APP_ID DISCORD_PUBLIC_KEY OPERATOR_DISCORD_ID DISCORD_ALARM_WEBHOOK; do pnpm wrangler secret put $s; done
   ```
   GitHub secrets for Actions: `INGEST_HMAC_SECRET`, `DISCORD_GOVERNOR_WEBHOOK`, data keys (FRED, Finnhub).

## A2. What was set up on 2026-10-22 (re-run safely)
```bash
set -a; . ./.dev.vars; set +a      # DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID, Alpaca paper keys
pnpm discord:setup                 # category, channels, webhook → workers/sentinel/.dev.vars, guild commands
```
GitHub: secrets `SENTINEL_TICK_SECRET`, `INGEST_HMAC_SECRET`, `FMP_API_KEY`, `FRED_API_KEY`; variables
`SENTINEL_URL`, `CORTEX_URL`. Run a research batch now: `gh workflow run research -f job=crypto` (or `equity`, `world`).
EDGAR needs secret `SEC_USER_AGENT` = `"<name> <contact email>"` (SEC policy); without it the world job skips EDGAR.
Local dry run: `cd research && UPSTREAM_DIR=<checkout> uv run python -m cortex_research.run crypto --dry-run`.

**Batch dispatcher token (ADR-032).** GitHub drops most free scheduled runs, so the brain starts the batch jobs
itself once it has a token:
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate.
2. Repository access: **Only select repositories** → `x-TheFox/Cortex-54`. Permissions → Repository →
   **Actions: Read and write** (Metadata: read is added automatically). Nothing else. Expiry: up to 1 year.
3. `pnpm wrangler secret put GH_DISPATCH_TOKEN` and paste it. The next pulse dispatches; each run appears in
   Actions as `research <job>` and in the journal as `DISPATCH`. Revoke the token to fall back to GitHub's crons.

**Web terminal (ADR-034).** Run `/terminal` in Discord; open the link it returns (single use, 10 min). The session
lasts 12 h. Rotate `WEB_SESSION_SECRET` (`openssl rand -hex 32 | pnpm wrangler secret put WEB_SESSION_SECRET`) to
sign everyone out.

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
| Anything feels wrong | `gh workflow run kill-switch -f action=kill -f reason="…"` (or Actions → kill-switch in the GitHub app) → cancels all orders and closes all positions on both accounts; `action=rearm` when resolved |
| Orphan position/order | entries blocked; close it in Alpaca or `/flatten`, then `/resume` |

Manual last resort: Alpaca dashboard → "Close all positions" + "Cancel all orders".

## D. Drills
- Weekly (paper): `/kill` via SENTINEL, verify flat within 2 pulses, re-arm with `/dial`.
- Monthly: revoke paper keys to simulate auth failure; verify REDUCE_ONLY + alarm.
