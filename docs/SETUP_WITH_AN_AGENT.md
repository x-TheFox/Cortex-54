# Set up CORTEX-54 with an AI agent

The CORTEX-54 app shows this prompt on first launch ("Let my AI agent do it"), with a copy button. Paste it into
Claude Code, Codex, Cursor or any agent that can run terminal commands on your computer. The agent asks you for each
key one at a time, says where to get it, configures everything with the `cortex` command, and checks every piece. The
app picks up each change within seconds.

Prefer not to paste keys into a chat? Say so when the agent asks: it will run `cortex setup` and you type the keys
straight into your own terminal instead.

---

```text
You are setting up CORTEX-54, an autonomous paper-trading agent, on this computer for me. Work step by step, explain
each step in one plain sentence before you do it, and ask me for one thing at a time, saying where to get it.

Ground rules (follow all of them):
- Never place an order, never fund an account, never touch real money. CORTEX runs on a simulated or PAPER account.
- Never print, log or repeat a secret back to me. When you pass a key to a command, don't echo the command with the key
  in your reply. If I'd rather type keys myself, run `cortex setup` interactively and let me type them in my terminal.
- Prefer free options. Suggest paid models only if I ask for them.
- Use the `--json` output of every `cortex` command to decide what to do next. If `cortex doctor --json` reports a
  problem, fix exactly that and run it again until it is clean (or tell me what only I can fix).
- The CORTEX app (if it is open) applies every change within a few seconds; no restart is needed.

Steps:
1. Find the `cortex` command: run `cortex --help`. If it is missing and I have the CORTEX-54 source folder, run
   `pnpm install` and `pnpm web:build` there and use `pnpm cortex` wherever these steps say `cortex`. If neither
   exists, tell me to install the CORTEX-54 app first and stop.
2. If there is no config yet, run `cortex setup --mode demo --yes`.
3. Ask whether I want demo mode (no accounts: a simulated $54 on live crypto prices) or paper mode (a free Alpaca paper
   account, which adds stocks, news and the research desk). For paper mode, walk me through creating the free Alpaca
   account at https://app.alpaca.markets/signup and generating PAPER API keys (never live keys), then save them:
   `cortex setup --mode paper --yes --set ALPACA_PAPER_KEY_ID=<id> --set ALPACA_PAPER_SECRET=<secret>`.
4. AI models. The court needs at least two different models; more is better, and CORTEX rotates through all of them.
   Ask me for keys one at a time, free ones first, and add each with `cortex llm add <key> --json` (it recognizes the
   provider from the key):
   - Google Gemini, free: https://aistudio.google.com/apikey
   - Groq, free: https://console.groq.com/keys
   - Optional: NVIDIA NIM (free credits, https://build.nvidia.com), OpenRouter, Anthropic or OpenAI (paid), or any
     other OpenAI- or Anthropic-compatible endpoint: `cortex llm add <key> --url <base-url> --models <a,b>`.
   - Optional, private and free: a local Ollama or LM Studio server, `cortex llm add http://127.0.0.1:11434/v1`
     (use `cortex llm models <url> --json` to see its models, then pass `--models`).
   After each, run `cortex llm list --json` and read me its notes. If only one model exists in total, tell me the court
   needs a second one; only if I insist, run `cortex llm prefs --same-model yes` and tell me why that is weaker.
5. Recommended: Cloudflare AI for Clef and Clairic (news triage and fact reading; free daily allowance). Walk me
   through https://dash.cloudflare.com → AI → Workers AI → Use REST API to get the account id and an API token, then
   `cortex setup --yes --set CLOUDFLARE_ACCOUNT_ID=<id> --set CLOUDFLARE_API_TOKEN=<token>`. If I skip it, tell me
   my own AI model stands in and performance is marginally lower.
6. Optional phone alerts: generate a random topic with `openssl rand -hex 16`, save it with
   `cortex setup --yes --set NTFY_TOPIC=cortex-<topic>`, and tell me to install the ntfy app and subscribe to
   `ntfy.sh/cortex-<topic>`. Send nothing to the topic yourself. Discord is optional too: the app's Settings page
   connects it from a bot token.
7. Run `cortex doctor --json` until it is clean (warnings are fine), then mark setup done:
   `cortex setup --yes --onboarded`.
8. If the CORTEX app is not running, start it in the background with `cortex service install`, then give me the
   one-time login link from `cortex link`.
9. Finish with a short summary: what's running, where the dashboard is, how to pause trading (`cortex kill`), and
   that the dashboard's ASK page explains any decision (WHY + a symbol).
```

---

## What the agent will touch

| Where | What |
|---|---|
| `~/.cortex54/` (Windows: `%USERPROFILE%\.cortex54`) | `config.json` (your keys, readable only by you), the brain's state and journal (SQLite), logs |
| Login items | one background service (`launchd` on macOS, a systemd user unit on Linux, a logon task on Windows) |
| Your Cloudflare account (cloud mode only) | two D1 databases, one KV namespace, two Workers (`cortex`, `cortex-sentinel`) |

Undo everything: `cortex service uninstall`, then delete `~/.cortex54`. In cloud mode, also delete the two Workers,
the D1 databases and the KV namespace in the Cloudflare dashboard.
