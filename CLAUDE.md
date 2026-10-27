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
item per call (ADR-027).** `clef-omni` (30B MoE, 3B active) appeared in our Workers AI catalog by 2026-10-24 but is
unused. **Clairic** `@cf/cloudflare/clairic` (preview, verified live 2026-10-24): extraction model, request
`{model:"clairic", state, fields:{id:{type: text|date|number|list|estimate, instructions, …}}, reference_date}`,
answers carry `value` + `confidence` (estimates: mean/p10/p90), 65,536-token context, $0.10/M input ≈ 9,091
neurons/M, no output billing (ADR-043). **Jev** (TypeSafe AI) is not in our Workers AI catalog (2026-10-24).

**Alpaca**
- Crypto: market / limit / stop_limit, TIF gtc / ioc, all fractional. **No `post_only` flag.** **Minimum order
  cost basis $10** (403 40310000, verified 2026-10-24; ADR-042 lifts risk-sized orders to it inside the caps). Fee tier
  <$100k 30-day volume: 0.15% maker / 0.25% taker. Paper does not charge fees.
- Equities: $0 commission; regulatory fees on sells round up to the cent (meaningful on $18 sells).
  Fractional supports market, limit, **stop, stop_limit** (regular hours). Extended hours: limit orders only
  (TIF day/gtc). Overnight session 8 pm–4 am ET Sun–Fri (fractional overnight coverage unclear, verify).
- Paper: market buys fill at ask / sells at bid; limit fills when touched (no queue); ~10% random partial
  fills; no fees, no slippage model. **We apply our own fee + slippage model to paper fills.**
- Paper equity can be reset to a custom amount (dashboard "Reset" → new API keys).
- A second $54 paper account (LAB, verified 2026-10-24: cash, crypto enabled) backs the LAB brain (ADR-045). Its keys
  are `ALPACA_LAB_KEY_ID/SECRET` (cortex + GitHub secrets).
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
- **Re-verified 2026-10-26 (bull prompt, live BTC):** Gemini 3.5/3.8 returned 503 "high demand" at peak (3.5 answered ~14–20 s
  later); qwen and gpt-oss-20b answer in ~2 s; nemotron (NIM and OpenRouter) answers in prose, not JSON; deepseek-v4.1-flash
  times out at 60 s (out of the court chains, ADR-056).
- **Canary 2026-10-26 (ADR-070):** Gemini 3.5/3.8 both 503 "high demand"; Groq `qwen/qwen3.8-27b` fails Groq's JSON
  validation (400) and its TPM cap on a 3–4K prompt; gpt-oss-20b/120b answer valid JSON in ~1.2 s; NIM Nemotron is
  valid 4/4 only with a ≥ 4,096-token output budget (it reasons first; at 1,500 it was cut off). Groq on this key also
  lists allam-2-7b, whisper and prompt-guard only. NIM kimi-k2.6, mistral-large-2, gemma-3 return 404 ("Function not
  found") and glm-5.3 times out at 60 s.
- Alpaca crypto quotes and bars work **without keys**; news needs keys (local demo mode relies on this, 2026-10-26).
- Chronos-2 (`amazon/chronos-2`, Apache-2.0) loads on CPU in ~65 s (first download) and forecasts in ~0.2 s per series.
- NVIDIA NIM: enabled for this key — `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`
  (`nemotron-3-super` is *not* enabled). OpenRouter `:free` errored on every test (left out of chains).
- **Verified 2026-10-24 (ADR-051):** Gemini Google Search grounding has no free quota; Groq `compound` is not on our key
  and `gpt-oss-120b` is capped at 8K tokens/min; NIM `nvidia/nemotron-3-ultra-550b-a55b` ≈3 s JSON (NIM
  `deepseek-v4.1-flash` timed out); OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` works (≈13 s), most other
  `:free` models are rate-limited or harness-only. Keyless web: DuckDuckGo HTML, Google/Bing News RSS, Wikipedia REST,
  Jina reader (`r.jina.ai`). The LLM keys are also GitHub secrets for the research desk.
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
desktop/                  Tauri v2 app (ADR-066): src-tauri/ shell; bundles dist/cortexd + an official Node runtime
hub/                      community hub Worker + D1 migrations (ADR-068), hosted by the publisher
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
- Clocks running in parallel: 7-day paper (Phase 1), 5-day posture cards (Phase 2).
- Local secrets: `.dev.vars` and `workers/sentinel/.dev.vars` (gitignored). Never print or commit them.
