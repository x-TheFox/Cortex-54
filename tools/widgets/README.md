# Desktop and phone monitoring (ADR-062)

All of these are **read-only**: none can trade, pause or flatten. Commands stay on Discord (signed) and the web
terminal (single-use login).

| Where | What | Needs |
|---|---|---|
| macOS menu bar | `swiftbar/cortex.30s.sh` (SwiftBar or xbar) | `PILL_TOKEN` secret |
| Windows tray | `windows/CortexTray.ps1` (PowerShell, no install) | `PILL_TOKEN` secret |
| Android / iOS push | the ntfy app, subscribed to your topic | `NTFY_TOPIC` secret |
| Any phone or desktop | the web terminal installed as an app (Chrome/Edge "Install", Safari "Add to Dock / Home Screen") | nothing new |

## Setup

1. Make two random values (never reuse another key):
   ```bash
   openssl rand -hex 24
   ```
2. Store them on the worker: `pnpm wrangler secret put PILL_TOKEN` and `pnpm wrangler secret put NTFY_TOPIC`
   (the topic must be 16–64 letters, digits, `_` or `-`; anyone who knows it can read the pushes, so keep it random).
3. Widgets: write `~/.cortex54-pill` (macOS) or `%USERPROFILE%\.cortex54-pill` (Windows) with the worker URL on
   line 1 and the `PILL_TOKEN` on line 2, `chmod 600` it on macOS.
4. Phone: install ntfy (F-Droid / Play Store / App Store), add a subscription to `ntfy.sh/<your topic>`.

Pushes cover alarms, fills and exits, court rulings, re-underwriting hearings and the weekly Governor/book cards.
Each push costs one subrequest; the free tier has room for thousands a day.
