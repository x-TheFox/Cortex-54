# Current status

Moved from CLAUDE.md §11 on 2026-11-02. Append new dated entries here, not in CLAUDE.md.


- 2026-10-22: Phase 0 merged (docs, config, schema, scaffold).
- 2026-10-22: Phase 1 safety spine code-complete on `phase-1-safety-spine`: Brain pulse (reconcile, fills,
  paper fee model, broker + synthetic stops, exits, breakers, reservations), baseline crypto strategy (PAPER
  only), Discord commands, sentinel kill-switch with KV flag. Tests incl. simulated pulses.
- 2026-10-22: DEPLOYED on the operator's Workers Free account (`cortex.samplayz2ks.workers.dev`,
  `cortex-sentinel.samplayz2ks.workers.dev`). D1 `cortex-journal` + KV `FLAGS` created; PAPER keys set;
  Discord guild wired (CORTEX-54 category, HUD live, slash commands, interactions URL verified). No LIVE keys.
  Kill switch via GitHub Actions (ADR-022). Cron slots freed later the same day → crons restored (ADR-021 rev.).
- 2026-10-22: the other worker (`mahoraga`, likely the source of the earlier AMD/META/NVDA/SOXL/SOXX paper fills)
  was deleted by the operator. CORTEX needs exclusive use of its accounts; unknown positions block entries.
- 2026-10-22: PR #2 merged (watchdog + kill-switch workflows active). Operator policy: no approve-each-trade on
  either account; real money only after total implementation + fully autonomous paper testing (ADR-024/025).
  Free LLM keys (Gemini, Groq, NIM, OpenRouter) verified and stored as `cortex` secrets for Phase 3.
- 2026-10-22: PR #3 merged. Paper kill drill PASSED (kill-switch.yml → sentinel flatten 207, KV flag, #alarms post;
  brain journaled KILL_CLEARED after re-arm). Phase 1 exit now only needs the 7-day unattended clock.
- 2026-10-22: Phase 2 built and live (PR open): ingest, research.yml, regime gate, posture cards, news intake.
  Keys stored: FMP + FRED (GitHub secrets), INGEST_HMAC_SECRET (cortex + GitHub). GDELT queued for Phase 3.
- 2026-10-22: PR #4 merged; research workflow verified on GitHub (crypto + equity ingest HTTP 200).
- 2026-10-22: Phase 3 started (branch `phase-3-triage`): Tier 1 clef-flash triage live over the queue
  (news + GDELT + EDGAR), world-intel batches hourly, #world-intel cards on promotion. EDGAR needs a
  `SEC_USER_AGENT` secret (contact email) from the operator. Next: Tier 2 (Clef 27B structure) and the court.
- 2026-10-22: PR #5 merged. GDELT DOC API is throttled on GitHub runners → world job now reads GDELT GKG bulk
  files as an hourly world-risk pulse + wire press releases (ADR-028). Tier 2 (Clef 27B) and the court are built
  (branch `phase-3-court`) and verified against real providers with `pnpm court:smoke` (no orders).
- 2026-10-22: PR #6 merged. Court was silent (Tier 1 bar too high, ~1 headline/hour, news re-queue bug) →
  ADR-029: Tier 1 bar 0.55/1.5, intake dedupe, wider universe, courtroom card for every session, `/court`.
  SEC_USER_AGENT is set (EDGAR active).
- 2026-10-22: PR #7 merged. Phase 4 Governor built (branch `phase-4-governor`, ADR-030): `governor.yml` daily
  (grades, postmortems, fitness, LIVE-gate tracker) and Sunday (report card to #governor, calibration proposal
  once ≥50 outcomes). Brain reads it via HMAC `/governor/export`; DAY_ROLL now carries pulses / max gap / equity.
  First live run posted a report card. Operator enabled "Actions may create PRs"; the workflow still falls back
  to a compare link if that is ever turned off. PRs opened by GITHUB_TOKEN don't trigger CI; CI runs on merge.
- 2026-10-22: Phase 5 options shadow lab built (branch `phase-5-options-lab`, ADR-031): research.yml
  job=options, virtual D1 ledger `options_shadow` (migration 0003 applied), three SHADOW strategies, staskh
  Black-Scholes + PMCC rubric ported (NOTICE.md). Deployed; first opens wait for market hours.
- 2026-10-23: PRs #8 and #9 merged. GitHub schedules began firing ~00:07 UTC but dropped most slots →
  ADR-032: the brain dispatches the batch workflows each pulse (dormant until the `GH_DISPATCH_TOKEN` cortex
  secret exists; RUNBOOK A2). GitHub crons stay as a deduped backup.
- 2026-10-23: PR #10 merged; `GH_DISPATCH_TOKEN` set (classic `repo` token; the operator accepted that).
- 2026-10-23: Phase 4 memory built (branch `phase-4-memory`, ADR-033): reputation → W_rep (rung-capped), scar
  tissue veto + lessons with Governor PR proposals, beliefs (hot schema v3). Phase 4 code-complete.
- 2026-10-23: PR #11 merged. Phase 6 cockpit built (branch `phase-6-cockpit`, ADR-034): HUD equity chart,
  #agent-terminal stream, web terminal (`public/`, `/terminal` login link, Command Deck / Court / Memory Vault /
  Options Lab), shared Discord/web command runner with a parity test. Deployed; WEB_SESSION_SECRET set.
  All roadmap build phases (0–6) are now code-complete; LIVE still needs the 30-day autonomous PAPER run.
- 2026-10-23: PR #12 merged. Spec gap pass (ADR-035): correlation guard, 72 h earnings blackout (Nasdaq + FMP
  calendar, fail closed), Stockbee setup screeners → Tier 2 (`gh workflow run research -f job=screeners`),
  daily journal chain verification, shadow-twin divergence; unused re-peg setting removed. Hot schema v5.
- 2026-10-23: PR #13 merged. Web terminal rebuilt in React as a dark cockpit (branch `web-react`, ADR-036):
  `web/` → `public/` via `pnpm web:build` (deploy:cortex runs it); `pnpm web:dev` for synthetic-data design work.
- 2026-10-23: ADR-037: Tier 1 bar 0.45/1.2, baseline on all 13 crypto pairs, HUD buttons (pause/resume/2-step
  flatten), in-panel plain-English guide. LIVE remains dormant pending the operator's decision.
- 2026-10-23 13:18 UTC: fresh start (ADR-038). Old paper keys had returned 401 since 12:59; the operator's new
  paper account ($54.00, no history) replaced them everywhere and `/admin/reset` cleared PAPER's hot state.
  The 7-day and 30-day autonomous clocks restart from this RESET.
- 2026-10-23: ADR-039 exception lane: exceptional catalysts (Tier 1 ≥ 0.85 / 2.2, Tier 2 ≥ 0.85) may trade through a
  REDUCE_ONLY gate at half size, one at a time; gate refusals are now graded; Tier 2 is one attempt per candidate.
- 2026-10-24: ADR-040: constitution v2 allows buying 1x inverse ETFs (SH, PSQ, RWM, BITI); new PAPER strategies
  EQUITY_INVERSE_BREAKOUT_V1 and CRYPTO_OVERSOLD_BOUNCE_V1 trade falling markets. True shorting needs a margin
  account (≥ $2,000), so it stays impossible at $54.
- 2026-10-24: ADR-041: Kronos-base forecasts (research job `kronos`, every 4 h on GitHub CPU, vol-rescaled sampled
  paths) → a LOW-confidence `forecast` block in court evidence only (operator: Kronos never trades by itself;
  CRYPTO_KRONOS_FORECAST_V1 is SHADOW).
- 2026-10-24: first buy attempts (Kronos BTC/DOT) refused by Alpaca's $10 crypto minimum → ADR-042 min-ticket rule.
- 2026-10-24: ADR-043: Clairic extracts typed catalyst facts (once per promoted candidate) into Tier 2/court evidence.
- 2026-10-24: ADR-044: the court is a full hearing (rebuttal + 3-seat panel) and posts a six-part transcript to Discord.
- 2026-10-24: ADR-045: LAB brain (`LabCortexDO`, D1 `cortex-lab`, LAB paper account) forward-tests Kronos and the
  research strategies (trend, RSI(2) pullback, turn-of-month); PAPER only runs strategies that graduate by PR.
- 2026-10-24: ADR-046: backtest lab (weekly). RSI(2) pullback PASSES → ACTIVE on PAPER; bounce and inverse ETFs lose
  net of costs → moved to LAB; trend and turn-of-month lose too (LAB only).
- 2026-10-24: ADR-047: web terminal FCST page (key 7): Kronos forecast band vs the robot's own plan per symbol.
- 2026-10-24: external audit (operator-supplied ledger) triaged claim by claim: ADR-048 (safety/failure-path fixes),
  ADR-049 (learning loop), ADR-050 (property tests, param schemas, doc reconciliation). Rejections recorded there.
- 2026-10-24: ADR-051: web research desk — a multi-step agent on GitHub Actions (read-only web tools, free LLM chain,
  code-checked citations) builds a dossier per court case; the court waits ≤ 25 min for it and cites it (`res_*`).
- 2026-10-24: ADR-052: Kronos also forecasts the 18 watchlist stocks (daily candles, 2 trading days) for the court and
  the FCST page; they never trade on it.
- 2026-10-24: every audit idea triaged (unbuilt ones in `docs/FUTURE_PLANS.md`). ADR-053 builds round 1: per-account kill scope,
  invariant monitor in /health, journal re-anchor, budget projection, dispatch receipts, deploy-lag alert, RATIFY
  cooling-off, drift tests. CI cannot deploy (no `CLOUDFLARE_API_TOKEN` secret): deploy with `pnpm deploy:cortex`.
- 2026-10-24: ADR-054 audit round 2: court hearing budget, provider caps, bear personas, freshness labels, breaker
  hysteresis, typical-spread costs, retrying broker reads, lost-submit recovery, slippage + bad prints, P5, injection suite.
- 2026-10-24: ADR-055 audit round 3 (Governor rigor, DSR/PBO in the backtest lab, funding shrink, HMM context). The
  audit work stops here; everything not built is in `docs/FUTURE_PLANS.md` with its trigger.
- 2026-10-24 15:53 UTC: first fills — LAB (Kronos forward test) bought BTC/USD and AAVE/USD (~$10 each).
- 2026-10-26: first exits — LAB closed BTC/USD and AAVE/USD on TIME_STOP (+$0.08, +$0.10). ADR-056 gate review: REDUCE_ONLY
  admits court stock entries at half size under the coach's ceiling, transitional macro input, warm-up floor 0.5, court
  bull-decline fix and deepseek out of the chains.
- 2026-10-26: ideas round (docs/IDEAS_WORKLOG.md, ADR-057…070): research desk v2, dynamic universe + scout, exit
  intelligence, lateness meter + resting convictions, sanity vetoes, /why /roast /book /universe, ntfy + widgets, BYOK
  models + portable Clef, cortexd local mode, desktop app, job queue + cortex deploy, community hub, Chronos-2 companion,
  drift canary + chaos test. Product direction: closed-source desktop/headless software + a hosted hub
  (docs/DISTRIBUTION.md).
- 2026-10-26 (evening): app-first round (operator; docs/IDEAS_WORKLOG.md §E). ADR-071: the app is the dashboard (FEED
  from a hot-store inbox, ASK, SETTINGS; Discord optional, connects from a bot token; LIVE ratification from the app on a
  fresh sign-in). ADR-072: the model pool (unlimited OpenAI/Anthropic-compatible endpoints, discovery, round robin with
  cooldowns and caps, one-model warning); Clef/Clairic only on Cloudflare AI, else a structured stand-in (marginally
  lower, and the user is told). ADR-073: first-launch onboarding (wizard or agent prompt), live settings reload,
  TODAY summary. Hot schema v9. ADR-074: the court waits for the deep dossier (fast one after 12 min); the research
  desk uses the user's pool; support file + HEALTH in the app; `cortex deploy` verifies and rolls back; model
  scoreboard. Every idea re-reviewed for the app-first objective (IDEAS_WORKLOG §F).
- 2026-10-27: final pass on the ideas worklog (§G): ADR-075 paid-model cost meter, daily spend caps, demote switch,
  court capacity slider, AI USE gauge in local mode; ADR-076 keys in the OS keychain, encrypted backup/restore, phone
  access over Wi-Fi with QR pairing, ntfy QR, reset, tray health; ADR-077 release workflow for every desktop platform
  with generated changelogs, signed auto-update and licences, static demo cockpit; ADR-078 broker conformance suite
  (fixed the sandbox selling what it didn't hold) and the first Brain.ts split (`src/cortex/cards.ts`).
- 2026-10-27: v0.1.0 released for every platform. ADR-079: MSIX (unsigned, `Add-AppxPackage -AllowUnsigned`), Apple
  signing/notarization when its secrets exist, licence key live (`CORTEX_LICENSE_PUBKEY` variable), demo cockpit on
  GitHub Pages. ADR-080: v0.1.1's macOS app showed as "damaged" (no bundle signature); bundles are now sealed ad-hoc.
  ADR-081: accounts of any size measured from where they started, fresh start when the broker account changes,
  "Make it cash-only" for margin paper accounts, no Cloudflare free-tier meter in local mode. ADR-082: outside links
  in the desktop app open in the system browser. ADR-083: the app can connect a live account (joins at Stop 0; the
  user may ratify whenever they choose, with the paper gate shown as a warning); setup no longer offers the agent path.
- 2026-10-27: ADR-084: the landing page (`landing/`): its own paper-and-ink identity, the real sizer and journal hash
  running on the page, constitution and limits printed from config/ at build time, the demo cockpit one click from
  the hero. GitHub Pages now serves the page at the root and the demo cockpit at `/demo/`.
- 2026-10-27: launch round (operator). ADR-085 rebrand: **Savant** (the app) with **Cortex** (the agent), "54" retired.
  ADR-086 Whop checkout/licences ($35/mo, $299/yr, 7-day trial, free demo) + the `savant-license` Worker. ADR-087 legal
  set + first-launch terms. ADR-088 pre-launch audit response (`docs/AUDIT_2026-10-27.md`). ADR-089 shipped-build
  protection (obfuscation, bytecode, tamper check). ADR-090 getsavant.pro on Vercel, downloads/updates via the domain.
  ADR-091 Governor proposals approved in the app on customer installs (U8 reworded). ADR-092 private source repo,
  public binary releases, no git for customers. ADR-093 accounts on getsavant.pro (Sign in with Whop), app device
  sign-in, docs. ADR-094 downloads at getsavant.pro/download/<target> (savant-downloads Worker), SETTINGS in groups. ADR-095 community
  hub live (hub.getsavant.pro, SETTINGS → Community, getsavant.pro/community). Licence server live at savant-license.samplayz2ks.workers.dev (also getsavant.pro/api).
- Clocks running in parallel: 7-day paper (Phase 1), 5-day posture cards (Phase 2).
- 2026-11-02: pre-ship round on `preship-round`: audit fixes (ADR-103), open court with 106 specialists (ADR-096), two-tier
  key routing and unlimited hearings (ADR-097), court replays + ELI5 (ADR-098), model catalog/benchmarks/chooser
  (ADR-099), billing on getsavant.pro (ADR-100), SEO (ADR-101), 20% impact pledge at /impact (ADR-102). Not deployed.
