# CLAUDE.md — CORTEX-54

This is the operating manual for any Claude session working in this repo. Read it fully before you touch code.
The original 45-page design spec ("Project CORTEX-54: System Design & Engineering Document") is the *vision*.
**This file and `docs/` are the *law*.** Where they disagree with the spec, they win. Every deviation is
recorded with its reason in `docs/DECISIONS.md`.

---

## 1. What we are building (one paragraph)

CORTEX-54 is a single, always-alive autonomous trading agent that runs **entirely on free tiers**
(Cloudflare Workers Free, GitHub Actions on a public repo, free LLM APIs, free market data) and trades two
Alpaca accounts in lockstep: a **$54 paper account** and a **$54 real-money account**. It reads the real
world (news, filings, crypto microstructure, regime data), filters it through a four-tier cognitive funnel
that spends thinking like money (math → Clef-flash → Clef → frontier LLM debate), and may only trade through
a schema-valid `DecisionContract` that a deterministic risk engine sizes and can veto. The app (web panel,
desktop shell) is the command center: feed, ask, settings, autonomy dial, kill-switch; Discord is an optional add-on
(ADR-071). Trading is fully autonomous: no human approves trades. The harness, not any model, is the product:
**models reason, code computes, the risk engine decides, the operator governs.**

Hard constraint from the operator: **$0 operating cost. No paid plans, no credit cards on file, ever.**
If a feature needs money, it does not ship; we find the free path or cut it.

**Product direction (operator, 2026-10-26):** CORTEX-54 is being commercialised as closed-source software customers run
themselves: a desktop app (local mode), a headless image, and a community hub we host (docs/DISTRIBUTION.md). The $0
rule still binds the operator's own deployment and every default; paid options (BYOK frontier models, the customer's
own cloud) are the customer's choice and always optional.

---

## 2. The non-negotiables (constitution — `config/constitution.json`)

These eight rules are enforced in code, tested, and can only be changed by the operator via a git commit.
No model, no Governor, no Discord button can change them at runtime.

1. **No contract, no order.** Every order traces to a schema-valid, persisted `DecisionContract`.
2. **Models never size.** LLMs/Clef output conviction (1–10) and probabilities only. Quantity, notional and
   price come exclusively from `PositionSizer` + `PreTradeValidator`.
3. **Hard caps.** Per-trade risk, total heat, per-position notional, daily loss and drawdown caps from the
   constitution can only be tightened by doctrine, never loosened. Cash only: no margin, no shorting, no naked
   options, no leveraged ETFs. Bearish exposure only by buying the constitution's 1x inverse ETFs (ADR-040).
4. **Every position has an exit.** Each position carries a stop; a broker-side stop wherever Alpaca accepts
   one, and a synthetic stop checked on every pulse otherwise.
5. **The kill-switch and Red breaker are sacred.** No model or Governor can override them. LIVE unlocks only with
   an operator-written postmortem. PAPER (fully autonomous) unlocks itself after a cooldown (constitution floor 12 h; doctrine 24 h) once flat,
   with a machine postmortem that counts against LIVE graduation. The `sentinel` worker can flatten everything
   independently of the brain.
6. **Fail closed.** Stale data, unknown broker state, reconciliation mismatch, or any free-tier budget at
   ≥90% puts the system in `REDUCE_ONLY`. We never fail open. We never trade on a guess.
7. **The journal is append-only and hash-chained.** No UPDATE or DELETE on journal tables (SQL triggers block
   them). The daily chain head is posted to Discord as an external anchor.
8. **Self-modification needs approval; real money needs ratification.** The Governor can only *propose*
   calibration/scar-tissue changes, and proposals can only tighten. On the publisher's own deployment a proposal is a
   GitHub PR the operator merges; on a customer's install it is a proposal in the app (Settings → Governor proposals)
   the user approves or dismisses (ADR-091). There is **no approve-each-trade mode**. LIVE joins at Stop 0 and trades
   only after the operator ratifies it (`RATIFY` on a fresh sign-in); the paper graduation gate is shown as advice
   before ratifying (ADR-083).

If you are about to write code that weakens any of these, stop and ask the operator.

---

## 3. Architecture at a glance (free edition)

```
               ┌──────────────── GitHub (public repo, free Actions) ─────────────────┐
               │ ci.yml: typecheck/test/deploy   research.yml: Python batch screeners │
               │ governor.yml (weekly): calibration, Monte Carlo, BH-FDR → opens PRs  │
               └───────────────┬───────────────────────────────▲─────────────────────┘
                     HMAC POST │ /ingest/batch                 │ wrangler d1 export
                               ▼                               │
┌──────────── Cloudflare Workers FREE ─────────────────────────┴───────────────────────────────┐
│ worker `cortex` (src/index.ts) — fetch router (≤10 ms CPU): Discord interactions, ingest,     │
│   health, web API. Cron */5 self-heal; the DO also self-arms its alarm (ADR-021 revised).     │
│   The pulse also dispatches the GitHub batch workflows on schedule (ADR-032).                │
│                                                                                               │
│   AgentCortexDO "CORTEX-54-PRIMARY" (SQLite-backed Durable Object, the only brain)            │
│     • alarm-driven PULSE (60 s when exposed/in-session, 300 s when flat) — NO always-on       │
│       outbound sockets (they'd burn ~83% of the free duration budget)                         │
│     • two BrokerAccounts: PAPER ($54) and LIVE ($54) — same contract, sized per account       │
│     • hot SQLite: positions, orders, risk reservations, breakers, regime, scar rules, cursors │
│     • Tier 0 math + Tier 1/2 Clef calls (Workers AI) + FreeTierBudget meter                   │
│   Tier 3 court runs in the pulse (ADR-028/044): bull → bear → rebuttal → panel → Clef judge   │
│   LabCortexDO "CORTEX-54-LAB" — same Brain on the LAB paper account + D1 `cortex-lab` (045)  │
│   D1 `cortex-journal` — append-only journal, contracts, rejections, beliefs, reputation       │
│                                                                                               │
│ worker `sentinel` (workers/sentinel) — separate deploy, cron * * * * * (+ GitHub backup tick │
│   every 30 min): heartbeat watchdog + LIVE daily-loss check + FLATTEN ALL (kill-switch.yml).  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
   Alpaca (paper + live REST)   Free LLMs (Gemini / Groq / NIM / OpenRouter :free)   Discord
```

Full detail: `docs/ARCHITECTURE.md`. Budget math: `docs/FREE_TIER_BUDGET.md`.

### The cognitive funnel

| Tier | Engine | Where | Budget | Job |
|---|---|---|---|---|
| 0 Reflex | TypeScript | DO pulse | free | stops, breakers, staleness, spread/fee gates, dedupe, watchlist relevance, ALL arithmetic |
| 1 Triage | `@cf/cloudflare/clef-flash` | DO | ~3,000 neurons/day | one item per call (~1.2 neurons), ≤8 per pulse; promote P(material) ≥ 0.45 and priority ≥ 1.2 (ADR-037) |
| 2 Structure | `@cf/cloudflare/clef` (27B) | DO | ~4,000 neurons/day | Tier 0 evidence (code) → long_favored, regime fit, bear-lethality, setup, quality; ≤1/pulse, ≤40/day |
| 3 Court | model pool (free chains + the user's endpoints, round robin, ADR-072) + Clef 27B synth | DO pulse (ADR-028) | free-tier RPD / endpoint caps | bull → **cross-family** bear → bull rebuttal → expert panel (quant, risk, macro) → Clef synth → calibrated COURT contract; ≤1/pulse, ≤12/day (ADR-044) |

Clef probabilities are **not** win rates. They pass through our own calibration map
(`config/calibration.json`, produced by the Governor from logged outcomes) before the sizer sees them.
Until ≥50 resolved outcomes exist, the calibrated probability is shrunk hard toward 0.5.

---

## 4. Verified facts

Moved to `docs/VERIFIED_FACTS.md` (checked 2026-10-22). Re-verify anything older than ~60 days there.

---

## 5. Spec errata (what the PDF gets wrong — do not re-introduce)

| Spec says | Truth / our decision |
|---|---|
| DO keeps Alpaca streams open with "WebSocket Hibernation" | Outbound sockets can't hibernate. We poll on alarms (ADR-002). |
| "Race conditions are impossible" in a DO | Every `await` lets other events interleave. Risk budget is **reserved synchronously in SQLite before any await** (ADR-004). |
| `post_only=true` on crypto | Doesn't exist. We price passively and verify the order rested; taker fills are accounted honestly. |
| clef-omni for chart vision | Unverified. Use Clef 27B (≤4 images) when charts are added. |
| Monthly LoRA retraining on Workers AI | Not available. We calibrate outputs ourselves (isotonic map) instead. |
| Clef answers "expected edge > 3× fees?" | That's arithmetic in tokens. Tier 0 computes it. |
| Options live at $75–$125 | The sizer forbids it until ~$1,000+. Options are paper shadow lab only. |
| Containers for Monte Carlo/backtests | Paid only. GitHub Actions (Python) does batch compute. |
| satori + resvg PNG HUD in the Worker | 10 ms CPU and 3 MB bundle on Free. Discord embeds + QuickChart image URLs instead. |
| Cloudflare Access for the web terminal | Avoided (card risk). Single-use sign-in links from `/terminal` or the app (ADR-034), no OAuth. |
| R2 archives, Vectorize semantic memory | R2 avoided. Beliefs live in D1 with tags; Vectorize only if D1 search proves insufficient. |
| Cron `0 13 * * 1-5` = 8:30 ET | UTC crons drift with DST. Session logic uses Alpaca `/v2/clock` + `/v2/calendar`. |
| Copy HKUDS/AI-Trader skills | No license. Ideas only. |
| ai4trade network, Polymarket arb, Pixel-Office, chaos theater, TaxGuard | Cut or deferred (see `docs/ROADMAP.md`). |
| Spec workspace path `/Users/mb/Documents/Github/Test` | The repo is `/Users/mb/Documents/Github/Cortex-54`. |

---

## 6. The $54 doctrine (short form — full math in `docs/RISK_DOCTRINE.md`)

- Equity E = $54. Rung R1 per-trade risk 2.5% → **$1.35 max loss**. Max position notional 35% → **$18.90**.
  Max 3 concurrent uncorrelated positions. Total heat ≤ 12% (R1).
- Sizer: `N = min(E·r_eff / d_stop, E·0.35, settled_cash_available)` where
  `r_eff = r_trade · (c/10) · (1 − D_bear) · W_rep · M_breaker`, `d_stop = |entry − stop|/entry + fee_rt`,
  stop ≥ 1.2 × ATR14 away. Round quantity **down**, risk **up**.
- Crypto: maker round-trip ≈ 0.30%, taker ≈ 0.50%. Target move must be ≥ 3× (fees + half-spread) → in
  practice ≥ 1.8–3.5%. Limit-first; never chase.
- Equities: fractional, $0 commission, track per-lot settlement (T+1) to avoid good-faith violations.
- Breakers (drawdown from high-water mark): Green <3% (×1.0), Yellow 3–6% (×0.5), Orange 6–10% (reduce-only),
  Red ≥10% or daily loss ≥5% (flatten + lock, operator postmortem to unlock).
- **No human approves trades, on either account (ADR-024).** PAPER is fully autonomous from day one (Stop 2).
  LIVE is **dormant (Stop 0)** until: all roadmap phases (0–6) are built, the fully autonomous PAPER account has run
  ≥30 days and passed the graduation gate *with modeled fees*, a live kill drill passes, and the operator ratifies
  `LIVE Stop 0 → 3`. Then LIVE runs autonomously. Valid dial stops: PAPER {0, 2, 4}; LIVE {0, 3, 4}.
- PAPER self-heals: auto-cleared entry blocks once a condition resolves; RED auto-unlocks after 24 h once flat
  (ADR-025). LIVE never self-unlocks from RED.
- Paper and live run the **same contract**; divergence (slippage, fills, fees) is a first-class metric.

---

## 7. Repository layout

```
CLAUDE.md                 ← you are here
README.md
NOTICE.md                 attribution for ported MIT code
config/
  constitution.json       8 untouchables + hard limits (operator-only, git-only)
  doctrine.yaml           tunable params: rungs, dial, breakers, funnel thresholds, budgets, routing
  skills-index.yaml       registry of every skill: family, runtime, phase, lifecycle status
  calibration.json        isotonic maps (Governor PRs)     scar-tissue.yaml  reflective rules (PR only)
scripts/build-config.ts   validates config/ and generates src/generated/config.ts (gitignored)
tsconfig.json / tsconfig.node.json   Workers types vs Node types (scripts, tests)
docs/
  ARCHITECTURE.md  FREE_TIER_BUDGET.md  RISK_DOCTRINE.md  DATA_SOURCES.md
  SKILLS_PORTING.md  ROADMAP.md  DECISIONS.md  RUNBOOK.md
migrations/               D1 migrations (wrangler d1 migrations apply)
src/
  index.ts                fetch router + cron + exports
  env.ts                  Env bindings type
  cortex/AgentCortexDO.ts the brain (pulse, accounts, hot state); LabCortexDO = the LAB brain (ADR-045, cortex/lab.ts)
  cortex/hot-schema.ts    DO SQLite schema (applied in constructor via blockConcurrencyWhile)
  contracts/              zod schemas: DecisionContract, constitution, doctrine (validated at boot)
  cortex/Brain.ts          ALL trading logic (pulse, reconcile, fills, stops, exits, entries, operator RPC)
  cortex/cards.ts          the cards and terminal lines the brain posts (pure rendering, split out by ADR-078)
  cortex/store.ts          SqlLike: the narrow SQL surface Brain depends on (DO storage or node:sqlite)
  risk/                    PositionSizer, PreTradeValidator, CircuitBreakerLadder, fees, rungs (pure)
  broker/                  Alpaca client + zod schemas + BrokerApi/MarketDataApi interfaces + registry (ADR-078)
  budget/FreeTierBudget.ts free-tier meter + per-invocation subrequest guard
  journal/Journal.ts       hash chain + D1 outbox
  strategy/                indicators + CRYPTO_BREAKOUT_BASELINE_V1 (deterministic, RULE contracts)
  discord/                 signature verify, commands, interactions, notifier (REST), token-only auto-setup (setup.ts)
  lib/                     sync sha256, uuidv7, client_order_id, money helpers
  clef/                    Clef client (real response format), Tier 1 triage, Tier 2 structure (pure)
  court/                   Tier 0 evidence, LLM router + providers, model pool (pool.ts, models.ts: endpoints, round
                           robin, discovery, presets — ADR-072), versioned prompts, bull/bear/synth/contract (pure)
  notify/                  ntfy push, the app's feed inbox (inbox.ts, ADR-071)
  data/ workflows/         (later)
web/                      the app's panel: React 19 + Vite (dark cockpit, ADR-036; FEED / ASK / SETTINGS / TODAY and
                          first-launch onboarding, ADR-071/073); builds into public/ (gitignored); mock-api.ts serves
                          synthetic data for `pnpm web:dev` only. PRODUCT.md / DESIGN.md at root
workers/sentinel/         independent watchdog + kill-switch worker (own wrangler.jsonc, vendored verify.ts,
                          writes the KV kill flag the brain reads — ADR-015)
research/                 Python (uv): cortex_research.run crypto|equity|world — runs pinned upstream skills, signs,
                          POSTs /ingest/batch (research.yml); governor/ (ADR-030); options/ shadow lab (ADR-031);
                          pytest in CI. ADR-026
local/                    cortexd local mode + `cortex` CLI (ADR-064/065): runtime, sandbox broker, jobs, service,
                          deploy, runner, memory packs, settings backend + live reload (settings.ts), agent-prompt.ts,
                          keychain, encrypted backups, licences (keychain.ts, backup.ts, license.ts — ADR-076/077)
landing/                  the product's landing page (ADR-084/090): static vanilla TS + GSAP/Lenis, numbers printed from config/
                          at build time, demo cockpit at /demo/; getsavant.pro on Vercel (`pnpm deploy:landing`). Notes: landing/CLAUDE.md
workers/license/          Whop licence-key server (ADR-086): machine-bound Ed25519 tokens (`pnpm deploy:license`)
workers/downloads/        permanent download links to the newest installers (ADR-094, `pnpm deploy:downloads`)
desktop/                  Tauri v2 app (ADR-066): src-tauri/ shell; bundles dist/cortexd + an official Node runtime
hub/                      community hub Worker + D1 migrations (ADR-068/095) at hub.getsavant.pro (`pnpm deploy:hub`)
src/universe/ src/portfolio/ src/hub/   dynamic universe + scout (058), exits/lateness/book (059–061), hub protocol (068)
test/                     vitest in Node: pure risk tests + full pulses against test/sim (FakeBroker + node:sqlite
                          with the real D1 migrations) — ADR-019
.github/workflows/        ci.yml (+ research.yml, governor.yml added in later phases)
```

---

## 8. Commands

```bash
pnpm install
pnpm config:build         # validate config/ vs constitution → src/generated/config.ts (runs before typecheck/test/dev/deploy)
pnpm typecheck            # Workers tsconfig (src, sentinel) + Node tsconfig (scripts, test)
pnpm test                 # vitest in Node (pure logic + simulated pulses; Node ≥22.13 for node:sqlite)
pnpm lint                 # biome check (pnpm format to fix)
pnpm dev                  # wrangler dev (local DO + D1; AI calls hit the real free quota)
pnpm db:migrate:local     # apply migrations to local D1
pnpm db:migrate:remote    # apply migrations to the real D1 (operator only)
pnpm web:dev              # web terminal on localhost with synthetic data (/?alert, /?empty scenarios)
pnpm deploy:cortex        # builds web/ then wrangler deploy (CI does this on main once CLOUDFLARE_API_TOKEN exists). NOT `pnpm deploy` (pnpm builtin)
pnpm deploy:sentinel      # deploy the independent watchdog/kill-switch worker
pnpm discord:setup        # idempotent: CORTEX-54 category + 8 channels, sentinel webhook, guild slash commands
gh workflow run research -f job=crypto    # or job=equity | world | options | screeners | kronos | backtest: run a batch now
pnpm court:smoke BTC/USD ["headline"] [--post]   # real bull/bear/Clef run on live evidence; never trades
# Discord /court SYMBOL convenes a real session (PAPER, all gates apply); cards go to #bull-vs-bear-court
pnpm discord:register     # (global) slash commands for both Discord apps (needs app ids + bot tokens in env)
gh workflow run governor -f weekly=true                     # governor now (report card + calibration proposal)
# Discord /terminal → single-use link to the web terminal (https://cortex.samplayz2ks.workers.dev)
gh workflow run kill-switch -f action=kill -f reason="…"   # independent FLATTEN ALL (ADR-022); action=rearm to clear
pnpm cortex <setup|doctor|start|demo|link|llm|service|kill|rearm|deploy|runner|hub|memory> [--json]   # local mode (ADR-064)
pnpm cortex llm add <key-or-url> [--models a,b]   # model pool (ADR-072): list | add | remove | models | prefs
pnpm cortex support       # redacted support file (no secrets) for asking for help (ADR-074)
pnpm cortex backup [--keys] | restore FILE | keychain on|off | license install FILE | reset --yes   # ADR-076/077
pnpm web:demo             # static demo cockpit on synthetic data → demo-dist/ (ADR-077)
pnpm landing:build        # landing page + demo cockpit → landing-dist/ (ADR-084); landing:dev / landing:preview to view
gh workflow run release -f bump=minor   # desktop release for every platform (auto on merges to main; ADR-077)
pnpm demo                 # keyless local demo on live crypto prices (simulated broker)
pnpm cortexd:build        # dist/cortexd bundle (no TS source); pnpm desktop:runtime && pnpm desktop:build → the app
pnpm canary               # model drift canary against every court model (weekly in canary.yml, ADR-070)
```

A doctrine value looser than the constitution fails `config:build`, which fails CI, which blocks deploy.
Bundle check: `pnpm wrangler deploy --dry-run --outdir <scratch>` (Phase 1: ~152 KB gzip; budget 2 MB).
Smoke test: `pnpm wrangler dev --test-scheduled`, then hit `/__scheduled?cron=*/5+*+*+*+*` and `/health`.

Secrets go in `.dev.vars` locally (template: `.dev.vars.example`) and `wrangler secret put` remotely.
Never commit secrets. Never log API keys, account numbers or Discord tokens.

---

## 9. Coding conventions

- TypeScript strict, ESM, no `any` at module boundaries. Validate every external payload (Alpaca, LLM, Clef,
  Discord, ingest) with zod before use. LLM output that fails the schema is a rejection, not a retry loop
  (one retry max, then reject + journal).
- **Money:** USD amounts in integer **cents** for comparisons and ledgers; ratios in `number`. Quantities
  from/to Alpaca are decimal strings, parsed once at the boundary. Conservative rounding everywhere.
- **Time:** epoch milliseconds UTC internally. Market sessions only from Alpaca clock/calendar. ET only for
  display.
- **IDs:** `contract_id` = UUIDv7. `client_order_id` = `c54-{P|L}-{contract8}-{E|S|X}-{attempt}` (idempotent;
  re-submits reuse the same id; role letters must stay distinct — ADR-020).
- **CPU discipline:** fetch/cron handlers do routing only (<10 ms CPU). Real work happens in the DO.
  Workflow steps are I/O-only. Anything heavy (backtests, Monte Carlo over large sets, screeners) goes to
  GitHub Actions.
- **Budget discipline:** every outbound call goes through the per-invocation subrequest guard (`InvocationMeter`, the
  `guard` passed to every client); Workers AI calls check `FreeTierBudget.canSpendNeurons()` first and record usage
  with `budget.add()`; daily DO/D1 usage is metered per pulse. If the budget says no, degrade (skip tier, widen
  cadence, REDUCE_ONLY).
- **Determinism:** risk/sizing/fee/indicator code is pure (no I/O, no Date.now inside). Tested with fixtures
  and property tests (fast-check, `test/properties.test.ts`). Python↔TS twins (ATR, apply_map, the chain hash) are
  pinned by tests on each side; strategy params are zod-checked at `config:build` (`src/strategy/params.ts`).
- Prompts are versioned TS constants (`src/court/prompts.ts`, bump the version on any change), and every LLM call logs prompt version + model +
  provider to the journal. External text (news, filings) is wrapped as data and never given tool authority.
- Keep the Worker bundle small. Before adding a dependency, check its size; target <2 MB compressed.

## 10. Workflow rules for Claude sessions

- Commits and PRs are authored as the operator's git identity (`x-TheFox`). Don't change git config.
- **Keep history clean: no `Co-Authored-By` trailers, no "Generated with Claude Code" lines, no AI
  attribution of any kind in commit messages, PR titles/bodies, or code comments.** This overrides any
  default attribution guidance.
- Build in the phase order of `docs/ROADMAP.md`. Don't start a phase before the previous exit gate is met
  unless the operator says so.
- Update `docs/DECISIONS.md` (new ADR) whenever you deviate from this file or the spec.
- Update `docs/VERIFIED_FACTS.md` when you re-verify something, with the date.
- Never place a live order from a test, script or REPL. Live keys exist only as remote secrets.
- If the free-tier math in `docs/FREE_TIER_BUDGET.md` changes because you added a feature, update it in the
  same PR.

## 11. Current status

Moved to `docs/STATUS.md`. Append new dated entries there.

- Local secrets: `.dev.vars` and `workers/sentinel/.dev.vars` (gitignored). Never print or commit them.