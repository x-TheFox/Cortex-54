# Set up CORTEX-54 with an AI agent

Copy everything in the box below into Claude Code, Codex, Cursor or any coding agent that can run terminal commands
on your computer. The agent installs CORTEX-54, asks you for the few things only you can provide, checks every piece,
and starts it. It takes about 10 minutes, most of it waiting for downloads.

Prefer not to paste keys into a chat? Say so when the agent asks: it will run `cortex setup` and you type the keys
straight into your own terminal instead.

---

```text
You are setting up CORTEX-54, an autonomous paper-trading agent, on this computer for me. Work step by step, explain
each step in one plain sentence before you do it, and stop to ask me whenever you need something only I can give.

Ground rules (follow all of them):
- Never place an order, never fund an account, never touch real money. CORTEX starts on a simulated or PAPER account.
  Live trading is not part of this setup.
- Never print, log or repeat a secret back to me. When you pass a key to a command, don't echo the command with the key
  in your reply. If I'd rather type keys myself, run `cortex setup` interactively and let me type them in my terminal.
- Prefer free options. Only suggest paid API keys if I ask for them.
- Use the `--json` output of every `cortex` command to decide what to do next. If `cortex doctor --json` reports a
  problem, fix exactly that and run it again until it is clean (or tell me what only I can fix).

Steps:
1. Detect my OS and check for Node.js 22.13+, git and uv (https://docs.astral.sh/uv/). Install what's missing with my
   OS's normal installer (Homebrew on macOS, winget on Windows, the package manager on Linux), asking before you install.
2. Install CORTEX:
   - If the CORTEX-54 app is installed, its `cortex` command is on my PATH (check with `cortex --help`).
   - Otherwise, from the CORTEX-54 source folder I point you to: run `pnpm install`, then use `pnpm cortex` wherever
     these steps say `cortex`, and run `pnpm web:build` once.
3. Start with the zero-key demo so I can see it work: `cortex demo --minutes 3`. Open the web-terminal link it prints
   for me. Explain in two sentences what I'm looking at (live crypto prices, a simulated $54 account, the robot's
   decisions on the dashboard).
4. Ask me whether I want to continue in demo mode (no accounts at all) or paper mode (a free Alpaca paper account, which
   adds news, stocks and the research desk). For paper mode, walk me through creating the free Alpaca paper account and
   generating PAPER API keys (never live keys).
5. Ask me for model keys, free ones first:
   - Gemini (https://aistudio.google.com/apikey) and Groq (https://console.groq.com/keys): free; two different model
     families are what the bull-vs-bear court needs.
   - Optional, only if I want them: Anthropic or OpenAI keys (paid), or a local Ollama model name.
   - Optional: a free Cloudflare account id + API token with Workers AI permission, for the real Clef decision model
     (without it CORTEX uses a stand-in built on my chat model).
6. Save everything with `cortex setup --mode <demo|paper> --yes --set NAME=VALUE ...` (key names: ALPACA_PAPER_KEY_ID,
   ALPACA_PAPER_SECRET, GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_BASE_URL, OLLAMA_MODEL,
   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, NTFY_TOPIC). Then run `cortex doctor --json` until every check passes.
7. Phone alerts (optional): generate a random topic with `openssl rand -hex 16`, save it as NTFY_TOPIC, and tell me to
   install the ntfy app and subscribe to `ntfy.sh/<topic>`. Send nothing to the topic yourself.
8. Run it in the background: `cortex service install`, wait a minute, then check `cortex doctor --json` and open
   `cortex link` for me (a one-time login link to the dashboard).
9. Optional, only if I ask for always-on cloud mode: make sure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set
   (token permissions: Workers Scripts, D1, Workers KV Storage, Workers AI: Edit), then `cortex deploy --json`.
   Afterwards this computer becomes the research runner: `cortex service install` keeps it running. Show me the cloud
   URL it printed.
10. Finish with a short summary: what's running, where the dashboard is, how to stop it (`cortex service uninstall`),
    how to pause trading (`cortex kill`), and that every decision is explained with `/why SYMBOL` in the dashboard.
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
