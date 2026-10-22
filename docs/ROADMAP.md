# Roadmap

Build in order. Each phase has an exit gate; don't start the next phase until it's met (operator can
override). ⚠️ marks the riskiest work.

## Phase 0 — Foundations
- Repo scaffold (this commit): CLAUDE.md, docs, config, D1 schema, TS/Wrangler/Vitest/Biome, CI.
- Cloudflare account on **Workers Free** (no card). Create D1 `cortex-journal`; put its id in `wrangler.jsonc`.
- Alpaca: paper account reset to $54; live account funded with $54; crypto enabled (state-dependent).
- Discord: server + 8 channels; two apps (CORTEX, SENTINEL); operator user ID recorded.
- GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **Exit:** CI green; `cortex` deploys from CI; `/health` returns the DO's boot hash; D1 migrated.

## Phase 1 — Safety spine, no AI ⚠️⚠️⚠️
- `AgentCortexDO`: hot schema, alarm pulse, cadence rules, `FreeTierBudget` meter + modes.
- Alpaca client (paper + live), zod-validated; clock/calendar/assets cache.
- Reconciliation (broker = truth), orphan handling, fill cursor via activities.
- ⚠️ Risk reservations; order state machine; idempotent `client_order_id`.
- PositionSizer, PreTradeValidator, CircuitBreakerLadder, settlement ledger, fee/slippage model (paper).
- ⚠️ Broker-side stops + synthetic stops + exit collars.
- Constitution/doctrine loaded + zod-validated at boot; boot hash journaled.
- D1 journal with hash chain; daily head posted to Discord.
- Discord: interactions endpoint, `/status`, `/pause`, `/dial`, alerts channel, approval buttons (Stop 1).
- `sentinel`: watchdog, independent LIVE loss check, `/kill` flatten-all.
- One dumb deterministic strategy (e.g. crypto 20-day breakout with ATR stop) at minimum size to exercise
  everything end to end, PAPER only.
- **Exit:** 7 days unattended on PAPER; zero reconciliation mismatches; kill drill passes on PAPER and LIVE
  (LIVE drill with no position or a $1 position); budget meter within plan; all risk code has property tests.

## Phase 2 — Data & context
- DataRouter with provenance + staleness. News (verify free access) and EDGAR intake.
- `research/` Python package + `research.yml`: breadth, distribution days, FTD, crypto regime (OKX/HL),
  screeners → `/ingest/batch` (HMAC).
- `ts-hot` indicator ports with Python parity fixtures. Exposure-coach combine step → posture card.
- **Exit:** daily posture card for equities + 4-hourly crypto regime card, accurate and on time 5 days running.

## Phase 3 — Cognitive funnel ⚠️⚠️
- Clef-flash Tier 1 (batched) and Clef Tier 2 with typed questions; neuron metering.
- Rejection shadow ledger from the first rejection.
- Calibration layer (shrinkage until ≥50 outcomes).
- LLM router with families + fallbacks; prompts versioned; ResearchSprintWorkflow (bull/bear/synth).
- ⚠️ Prompt-injection hardening and schema-only outputs.
- DecisionContract end-to-end; PAPER at Stop 2, LIVE at Stop 1 (approve each).
- **Exit:** ≥10 contracts produced; zero budget breaches; zero schema-invalid orders; approval flow works.

## Phase 4 — Learning loop
- signal-postmortem classification; Brier + reliability; source reputation; skill fitness.
- `governor.yml` weekly: report card, Monte Carlo, BH-FDR, rejection grading → PRs to config.
- Beliefs (D1) with decay; scar tissue via PR.
- **Exit:** first Governor PR merged by the operator; report card posted.

## Phase 5 — Options shadow lab (parallel with 4)
- Greeks/IV, spread structurer, PMCC rubric (ts-hot); options chain via Alpaca indicative feed.
- Separate paper account if Alpaca allows multiple; otherwise virtual ledger in D1 with pessimistic fills.
- **Exit:** ≥30 shadow options trades logged and scored.

## Phase 6 — Cockpit polish
- Discord command-center HUD (embeds + QuickChart), all 8 channels wired.
- Web terminal: static SPA on `cortex`, Discord OAuth, hibernatable WS; Command Deck, Clef Studio,
  Memory Vault first.
- **Exit:** every control has parity between Discord and web.

## Phase 7 — LIVE autonomy
- LIVE Stop 1 → Stop 3 per `RISK_DOCTRINE.md` §7 gates, operator ratification.
- Live incident drill (sentinel flatten with a real position).

## Deferred / cut
| Item | Status | Reason |
|---|---|---|
| Satori/resvg PNG HUD | deferred indefinitely | 10 ms CPU, bundle size |
| Vectorize semantic memory | deferred until D1 search is insufficient | not needed at our volume |
| Chart images into Clef | Phase 3+ optional | needs off-Worker PNG (QuickChart) and neuron budget |
| Chaos drills | lite version in Phase 1 (kill drill); full monthly drills Phase 7+ | |
| TaxGuard (wash sales) | R3+ | negligible at $54 |
| Polymarket read-only macro | Phase 7+ | |
| ai4trade / HKUDS NET skills | cut | no license; negative value |
| Clef LoRA retraining | cut | not available on free / not self-serve |
| Hot-mode outbound WebSocket | optional, budget-gated | duration budget |
