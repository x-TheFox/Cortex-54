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
a schema-valid `DecisionContract` that a deterministic risk engine sizes and can veto. A Discord bot is the
command center (alerts, HUD, autonomy dial, kill-switch). Trading is fully autonomous: no human approves trades. The harness, not any model, is the product:
**models reason, code computes, the risk engine decides, the operator governs.**

Hard constraint from the operator: **$0 operating cost. No paid plans, no credit cards on file, ever.**
If a feature needs money, it does not ship; we find the free path or cut it.

---

## 2. The non-negotiables (constitution — `config/constitution.json`)

These eight rules are enforced in code, tested, and can only be changed by the operator via a git commit.
No model, no Governor, no Discord button can change them at runtime.

1. **No contract, no order.** Every order traces to a schema-valid, persisted `DecisionContract`.
2. **Models never size.** LLMs/Clef output conviction (1–10) and probabilities only. Quantity, notional and
   price come exclusively from `PositionSizer` + `PreTradeValidator`.
3. **Hard caps.** Per-trade risk, total heat, per-position notional, daily loss and drawdown caps from the
   constitution can only be tightened by doctrine, never loosened. Cash only: no margin, no shorting, no naked
   options, no leveraged/inverse ETFs.
4. **Every position has an exit.** Each position carries a stop; a broker-side stop wherever Alpaca accepts
   one, and a synthetic stop checked on every pulse otherwise.
5. **The kill-switch and Red breaker are sacred.** No model or Governor can override them. LIVE unlocks only with
   an operator-written postmortem. PAPER (fully autonomous) unlocks itself after a cooldown (≥12 h) once flat,
   with a machine postmortem that counts against LIVE graduation. The `sentinel` worker can flatten everything
   independently of the brain.
6. **Fail closed.** Stale data, unknown broker state, reconciliation mismatch, or any free-tier budget at
   ≥90% puts the system in `REDUCE_ONLY`. We never fail open. We never trade on a guess.
7. **The journal is append-only and hash-chained.** No UPDATE or DELETE on journal tables (SQL triggers block
   them). The daily chain head is posted to Discord as an external anchor.
8. **Self-modification is a pull request; real money needs ratification.** The Governor can only *propose*
   doctrine/scar-tissue/calibration changes as a GitHub PR; the operator merges. There is **no approve-each-trade
   mode**. LIVE stays dormant (Stop 0) until every roadmap phase is built and the fully autonomous PAPER account
   passes the graduation gate; then the operator ratifies once (`RATIFY`) and LIVE trades autonomously.

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
│                                                                                               │
│   AgentCortexDO "CORTEX-54-PRIMARY" (SQLite-backed Durable Object, the only brain)            │
│     • alarm-driven PULSE (60 s when exposed/in-session, 300 s when flat) — NO always-on       │
│       outbound sockets (they'd burn ~83% of the free duration budget)                         │
│     • two BrokerAccounts: PAPER ($54) and LIVE ($54) — same contract, sized per account       │
│     • hot SQLite: positions, orders, risk reservations, breakers, regime, scar rules, cursors │
│     • Tier 0 math + Tier 1/2 Clef calls (Workers AI) + FreeTierBudget meter                   │
│   ResearchSprintWorkflow — Tier 3 bull / bear / synth → DecisionContract (I/O-only steps)     │
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
| 1 Triage | `@cf/cloudflare/clef-flash` | DO | ~3,000 neurons/day | one item per call (~1.2 neurons), ≤8 per pulse; promote P(material) ≥ 0.70 and priority ≥ Shadow |
| 2 Structure | `@cf/cloudflare/clef` (27B) | DO | ~4,000 neurons/day | Tier 0 evidence (code) → long_favored, regime fit, bear-lethality, setup, quality; ≤1/pulse, ≤40/day |
| 3 Court | free LLM chains + Clef 27B synth | DO pulse (ADR-028) | free-tier RPD | bull → **cross-family** bear → Clef synth → calibrated COURT contract; ≤1/pulse, ≤12/day |

Clef probabilities are **not** win rates. They pass through our own calibration map
(`config/calibration.json`, produced by the Governor from logged outcomes) before the sizer sees them.
Until ≥50 resolved outcomes exist, the calibrated probability is shrunk hard toward 0.5.

---

## 4. Verified facts (checked 2026-10-22; re-verify anything older than ~60 days)

**Cloudflare Workers Free**
- 100k Worker requests/day. **10 ms CPU** per HTTP request and per cron invocation. 50 subrequests per
  invocation (1,000 to Cloudflare services like D1/AI). 5 cron triggers per account. 128 MB memory.
  Bundle: design for ≤3 MB compressed (the Workflows docs state 3 MB on Free).
- Durable Objects on Free: SQLite backend only. 100k requests/day, **13,000 GB-s duration/day**, 5M rows
  read + 100k rows written/day, 5 GB storage. WebSocket incoming messages count 20:1; outgoing are free.
- **Outbound WebSockets from a DO cannot hibernate** and keep it billed for wall-clock. An always-on 128 MB DO
  costs 10,800 GB-s/day (83% of the free allowance). Hence the alarm-pulse design.
- Exceeding any free limit → operations **fail with errors** until 00:00 UTC. Fail-closed matters here.
- Workflows on Free: 10 ms CPU per step, 1,024 steps per workflow, 100 concurrent instances, 3-day
  retention, executions share the 100k/day request pool.
- D1 on Free: 10 DBs, 500 MB per DB, 5 GB total, 50 queries per invocation, 100 bound params per query.
- Workers AI Free: **10,000 neurons/day**, hard fail when exhausted. Rates (neurons per 1M input tokens):
  clef-flash 3,455; clef 21,818; gpt-oss-120b 31,818 in / 68,182 out; llama-3.3-70b 26,668 in / 204,805 out.
  Clef output is not listed as billed.
- **Not available on our plan:** Containers (paid only); RL fine-tuning for Clef (design-partner only).
  **Avoided:** R2 and Zero Trust (may require a payment method on file).

**Clef** (launched 2026-10-01; API verified live 2026-10-22): `@cf/cloudflare/clef` (27B, vision, ≤4 images)
and `@cf/cloudflare/clef-flash` (9B). **Context window 24,576 tokens** (questions + state; state is truncated to
fit; *not* 64K as third parties claimed). ≤64 questions/request. Request
`{model, state, questions:{id:{type, instructions, criteria?}}}`; response `answers[id]` =
`{type:"noul", noul}` | `{type:"choice", choice, probabilities, confidence}` | `{type:"score", score (0..n-1),
probabilities, legend, confidence}`, plus `usage.input_tokens`. clef-flash ≈ $0.038/M input tokens (= 3,455
neurons/M); output free. **Batching several items into one state compresses and reorders scores — score one
item per call (ADR-027).** `clef-omni` is not in the official changelog — do not depend on it.

**Alpaca**
- Crypto: market / limit / stop_limit, TIF gtc / ioc, all fractional. **No `post_only` flag.** Fee tier
  <$100k 30-day volume: 0.15% maker / 0.25% taker. Paper does not charge fees.
- Equities: $0 commission; regulatory fees on sells round up to the cent (meaningful on $18 sells).
  Fractional supports market, limit, **stop, stop_limit** (regular hours). Extended hours: limit orders only
  (TIF day/gtc). Overnight session 8 pm–4 am ET Sun–Fri (fractional overnight coverage unclear, verify).
- Paper: market buys fill at ask / sells at bid; limit fills when touched (no queue); ~10% random partial
  fills; no fees, no slippage model. **We apply our own fee + slippage model to paper fills.**
- Paper equity can be reset to a custom amount (dashboard "Reset" → new API keys).
- Free data plan: equities IEX-only; options "indicative" feed; 200 REST calls/min; latest 15 min of
  historical bars not queryable; WebSocket symbol cap (historically 30). Crypto data is free.
- PDT rule removed by FINRA effective 2026-06-04 (broker phase-in to 2027-10-20). For a $54 cash account the
  binding constraint is **T+1 settled cash / good-faith violations**, not PDT.
- Options levels: L1 covered/CSP, L2 long calls/puts, L3 spreads. The smallest defined-risk spread (~$15–35
  max loss) exceeds our per-trade risk cap until equity is ~$1,000+. **Options are paper-only (shadow lab)
  until the sizer itself permits them.**

**Data & LLM free tiers (third-party sourced, volatile — the code must degrade gracefully)**
- Groq ~30 RPM / 1K RPD / 200K TPD per model (gpt-oss-120b, gpt-oss-20b, qwen3.8-27b). **Verified 2026-10-22:**
  `openai/gpt-oss-120b` (with `reasoning_effort: low`) and `qwen/qwen3.8-27b` return JSON-mode output.
- Gemini (AI Studio) free: **use the Interactions API** (`POST /v1beta/interactions`, `response_format` with a JSON
  schema). `generateContent` 404s for current models and `gemini-2.5-flash` is closed to new users.
  `gemini-3.5-flash` ≈ 7–25 s; `gemini-3.8-flash` is often 503 "high demand". Prompts may be used for training.
- NVIDIA NIM: enabled for this key — `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`
  (`nemotron-3-super` is *not* enabled). OpenRouter `:free` errored on every test (left out of chains).
- CoinGecko Demo ~10k credits/month. SEC EDGAR 10 req/s with a contact User-Agent.
- **Binance/Bybit block US IPs** (and GitHub runners are US). Use OKX / Hyperliquid / Coinbase / Kraken /
  Deribit public endpoints for funding, OI and IV. The tradermonty `crypto-regime-analyzer` uses Binance;
  our port swaps the funding source.
- Verified 2026-10-22: Alpaca news (Benzinga) is on the free plan; OKX public funding works from US; GDELT DOC
  2.0 API is free/keyless (≤1 req / 5 s); upstream tradermonty breadth/uptrend run keyless; FTD/macro/market-top
  run on the FMP free key; exposure-coach combines them.
- GitHub Actions: public repo → free standard runners. Cron is UTC, can be delayed 15–30 min or skipped, and
  **scheduled workflows auto-disable after 60 days of repo inactivity.** The brain alarms on stale batch data.

**Licenses:** `tradermonty/claude-trading-skills` MIT, `staskh/trading_skills` MIT → port with attribution
(`NOTICE.md`). `HKUDS/AI-Trader` has **no license** → ideas only, never copy code.

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
| Cloudflare Access for the web terminal | Avoided (card risk). Discord OAuth restricted to the operator's user ID. |
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
  cortex/AgentCortexDO.ts the brain (pulse, accounts, hot state)
  cortex/hot-schema.ts    DO SQLite schema (applied in constructor via blockConcurrencyWhile)
  contracts/              zod schemas: DecisionContract, constitution, doctrine (validated at boot)
  cortex/Brain.ts          ALL trading logic (pulse, reconcile, fills, stops, exits, entries, operator RPC)
  cortex/store.ts          SqlLike: the narrow SQL surface Brain depends on (DO storage or node:sqlite)
  risk/                    PositionSizer, PreTradeValidator, CircuitBreakerLadder, fees, rungs (pure)
  broker/                  Alpaca client + zod schemas + BrokerApi/MarketDataApi interfaces
  budget/FreeTierBudget.ts free-tier meter + per-invocation subrequest guard
  journal/Journal.ts       hash chain + D1 outbox
  strategy/                indicators + CRYPTO_BREAKOUT_BASELINE_V1 (deterministic, RULE contracts)
  discord/                 signature verify, commands, interactions, notifier (REST)
  lib/                     sync sha256, uuidv7, client_order_id, money helpers
  clef/                    Clef client (real response format), Tier 1 triage, Tier 2 structure (pure)
  court/                   Tier 0 evidence, LLM router + providers, versioned prompts, bull/bear/synth/contract (pure)
  data/ workflows/         (later)
workers/sentinel/         independent watchdog + kill-switch worker (own wrangler.jsonc, vendored verify.ts,
                          writes the KV kill flag the brain reads — ADR-015)
research/                 Python (uv): cortex_research.run crypto|equity — runs pinned upstream skills, signs,
                          POSTs /ingest/batch (research.yml); pytest in CI. ADR-026
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
pnpm deploy:cortex        # wrangler deploy (CI does this on main once CLOUDFLARE_API_TOKEN exists). NOT `pnpm deploy` (pnpm builtin)
pnpm deploy:sentinel      # deploy the independent watchdog/kill-switch worker
pnpm discord:setup        # idempotent: CORTEX-54 category + 8 channels, sentinel webhook, guild slash commands
gh workflow run research -f job=crypto    # or job=equity: run a research batch now
pnpm court:smoke BTC/USD   # real bull/bear/Clef run on live evidence; never trades
pnpm discord:register     # (global) slash commands for both Discord apps (needs app ids + bot tokens in env)
gh workflow run kill-switch -f action=kill -f reason="…"   # independent FLATTEN ALL (ADR-022); action=rearm to clear
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
- **Budget discipline:** every call to Workers AI, an LLM provider, D1, or an external API goes through
  `FreeTierBudget.charge()` first. If it says no, degrade (skip tier, widen cadence, REDUCE_ONLY).
- **Determinism:** risk/sizing/fee/indicator code is pure (no I/O, no Date.now inside). Tested with fixtures
  and property tests (fast-check). Python parity fixtures for ported skills live in `test/fixtures/`.
- Prompts are versioned files (`src/court/prompts/*.md`), and every LLM call logs prompt version + model +
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
- Update §4 "Verified facts" when you re-verify something, with the date.
- Never place a live order from a test, script or REPL. Live keys exist only as remote secrets.
- If the free-tier math in `docs/FREE_TIER_BUDGET.md` changes because you added a feature, update it in the
  same PR.

## 11. Current status

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
- Clocks running in parallel: 7-day paper (Phase 1), 5-day posture cards (Phase 2).
- Local secrets: `.dev.vars` and `workers/sentinel/.dev.vars` (gitignored). Never print or commit them.
