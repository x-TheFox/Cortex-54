# Ideas worklog (2026-10-26)

One list for everything on the table: the operator's list (§A), the 169 items of the dossier export
(`docs/cortex54-dossier-export-2026-10-26T17-36-02.json`, §C), what was still parked in `docs/FUTURE_PLANS.md` (§D)
and ideas of my own that came up while building (§B). Every item has a verdict.

| Mark | Meaning |
|---|---|
| `[x]` | built and tested in this round |
| `[ ]` | accepted, not built yet |
| `[~]` | built a different (better) version; the line says how |
| `[-]` | rejected; the line says why |
| `[⏸]` | deferred; the line names the trigger that brings it back |
| `[=]` | already in the system; the line says where |
| `[→A]` `[→B]` | merged into a line in §A or §B and tracked there |

The hard limits still apply to every line: $0 operating cost, the constitution (long-only cash, models never size, every
position has an exit, fail closed), D1 migrations are operator-applied (so new state goes into the DO hot schema), and
nothing changes LIVE (dormant at Stop 0).

---

## A. Operator's list

### Research desk
- [x] **Remove the 3-tool-call limit.** The agent may now batch up to 8 tool calls per step, and they run in parallel
  (thread pool), so a wide step costs one round of latency, not eight.
- [x] **Research covers general news and the catalyst's own story.** Every run has three scopes: *market* (macro,
  sector, the asset class today), *catalyst trace* (the headline that triggered the case: the original source, who
  reported it first, what followed it) and *the asset itself*. The harness seeds the first step with one search per
  scope so neither is skipped, and the dossier carries separate `market_context` and `catalyst_trace` sections.
- [x] **Automatic compaction.** When the prompt passes 55% of the smallest model context in the chain, a compaction
  micro-pass folds old notes and step history into a dense digest (every URL and number kept, checked in code), and the
  run continues. Repeats as often as needed.
- [x] **Long-running research.** Two rings: a *fast* dossier is posted as soon as the core picture exists (the court
  waits for this one), then the same run keeps going (*deep ring*, up to ~2 h, configurable) and posts a deeper
  version that replaces it. Held positions get *watch dossiers* (MLP3-003) that track the bear's kill criteria.

### Universe
- [x] **Every symbol can be watched and traded (generalisation).** Dynamic universe: any active, tradable Alpaca asset
  passes a code screen (price ≥ $2, 20-day dollar volume, spread, fractionable for stocks, no leveraged or inverse
  ETF unless the constitution lists it, no OTC) and joins a hot `universe` table with a TTL. The doctrine watchlists
  stay as the permanent core.
- [x] **Scout that ports symbols in on demand.** News intake reads the whole Alpaca news stream (not just watchlist
  symbols). A zero-neuron Tier 0.5 prefilter (keywords, source, symbol count, near-duplicate check) keeps Tier 1 costs
  flat; anything Tier 1 promotes for an unknown symbol is screened and hot-ported by the scout. The research desk also
  names related symbols (suppliers, peers, sector ETF), which the scout adds as *watch-only*.

### Crowd / network
- [~] **Crowd-sourced systems, forum, copy trading, leaderboards.** A marketplace and forum need users, moderation and
  payment rails (cost, liability). The foundation that works for one operator today and scales later:
  - [~] **Signed public feed** → built as the community hub instead (ADR-068): agents publish signed, hash-linked journal rows to a hub we host; the hub recomputes every hash. Original plan: (`/feed.json`, `/feed.atom`, off by default): contracts, court verdicts, exits and
    ideas, each with its journal hash, so anyone can follow and verify the record (track-record proof, MLP4-022).
  - [x] **Follower mode** (ADR-068: a followed agent's court approvals become Tier 2 leads; never orders). Original plan: (copy trading done safely): point a CORTEX instance at a leader's feed; the leader's
    contracts become *candidates* that go through this instance's own gates, court and sizer. No blind copying.
  - [~] **Forum**: the repo goes private for the product, so GitHub Discussions is out; the hub's leaderboard + packs are the community core, with a Discord/Discourse forum as an operator choice. Original plan: GitHub Discussions on the public repo (free); the feed links there. No custom forum to run.
- [x] **Memory uploading.** `.scar` packs: `pnpm memory:export` writes scar rules + beliefs + lessons as a signed JSON
  pack; `pnpm memory:import` turns a pack into a branch and PR (constitution U8: self-modification is a PR).
- [~] **Strategy integration marketplace.** Running third-party code inside the risk path is the wrong trust model.
  Instead: a strategy plugin interface + manifest, and the existing gate (backtest DSR/PBO → LAB forward test → PR
  to PAPER). Documented as the SDK; no marketplace until there are outside authors.
- [~] **Following and copy trading of leading agents.** See follower mode above.

### Models and local
- [~] **BYOK for frontier models.** Paid keys break the $0 rule for this operator, so nothing is wired to paid APIs by
  default. Built instead: any OpenAI-compatible endpoint (OpenAI, OpenRouter paid, Together, Ollama, LM Studio) can be
  added through one env var and used in any court chain. Dormant without keys.
- [~] **Clef on local.** Clef's weights are not public, so it can't run locally. Built instead: a Clef-compatible
  shim (same request/answer shape: choice/score + probabilities) on any local or BYOK chat model, used by local mode.
- [x] **Fully local mode with background runner.** `pnpm local` runs the same Brain in Node: file-backed SQLite,
  a local journal, Alpaca paper (own account only) or a keyless simulated broker, free LLM chains, and Clef through the
  Cloudflare REST API or the shim. `pnpm local:install` writes a launchd (macOS), systemd (Linux) or Task Scheduler
  (Windows) service. `pnpm demo` runs it with no keys at all.
- [~] **Widgets for macOS and Windows.** Native widget kits need signed app bundles. Built instead: a tokened `/pill`
  JSON endpoint, a SwiftBar/xbar menu-bar plugin (macOS) and a PowerShell tray app (Windows), both read-only, plus an
  installable PWA view of the web terminal.
- [~] **Android app for close monitoring.** A native app costs a $25 Play fee and its own codebase. Built instead:
  push alerts through ntfy (free, open source, has an Android app) and the web terminal as an installable PWA with a
  phone layout.
- [x] **Kronos companions (Timer-S1 and others; research needed).** Research the current free time-series foundation
  models, then run the best CPU-friendly ones beside Kronos as SHADOW forecasts. They are logged and graded in LAB but
  don't reach the court until they beat Kronos on the same grading (keeps Kronos' own grade clean, FUTURE_PLANS W2-31).

### Exits and portfolio ("90% of IQ goes to entries")
- [x] **Excursion tracking:** MFE/MAE per position every pulse, plus 1h/4h/1d/3d post-exit excursions (MLP6-005).
- [x] **Breakeven ratchet:** once a position is +1R, the stop moves to entry + fees. It only ever tightens.
- [x] **Hold-or-harvest at target:** when the target is hit while momentum is intact, code converts the exit into a
  trailing stop (width from ATR and regime volatility) instead of selling at the first touch (MLP2-002, MLP4-003).
- [x] **Re-underwriting hearings:** a material headline about a held symbol, or a tripwire (regime flip, Kronos p10
  breach, funding spike, a bear kill criterion), triggers a Clef review: HOLD, TIGHTEN or EXIT. Models choose the
  action class only; code computes the new stop (MLP4-001, MLP4-002, MLP0-001, MLP1-009, MLP3-009).
- [x] **Event de-risk:** equities exit before earnings inside the blackout window (MLP4-006).
- [x] **Opportunity-cost rotation:** a stagnant position (held > half its horizon, |R| < 0.25) is released when a
  better court-approved candidate is waiting and slots are full (MLP4-004, MLP3-004).
- [x] **Weekly book review:** concentration, correlation, net beta to BTC/SPY, stale positions and a worst-case
  stress number, posted Sunday (MLP4-005, MLP4-032 light).
- [x] **Exit scorecard in the Governor:** money left on the table, give-back, saved-by-exit (MLP4-007).

---

## B. Ideas of my own (added while building)

- [x] **Lateness meter** (also dossier PSS-014 / MLP5-009 / MLP1-005): share of the catalyst's expected move already
  done between first report and now, plus a volume z-score. It's a Tier 0 evidence field, and the court refuses at ≥ 0.7.
- [x] **Resting convictions** (also MLP6-003 / MLP6-009): when price runs past an approved entry zone, the contract
  rests (up to its horizon, max 48 h) instead of being rejected; each pulse re-checks the zone and every gate.
- [x] **Temporal fact sheet** (also MLP0-013): every court prompt opens with today's date, the session and fresh
  regime numbers built in code.
- [x] **Stablecoin depeg + venue check** (also MLP0-021): crypto entries are refused when USDT or USDC sits more than
  50 bps from $1, or when Alpaca's mid disagrees with Coinbase's public ticker by more than 1%.
- [x] **`/why SYMBOL`** (also MLP0-011, MLP4-019): a deterministic answer from the hot state and journal (last contract,
  verdict, rejection reasons, exit reason). No LLM is needed, and nothing is invented.
- [x] **`/roast SYMBOL thesis`** (Co-Pilot, PSS-013): the operator's own idea goes through the full court and no
  order is ever placed.
- [x] **Model drift canary** (also MLP0-012): a weekly workflow sends golden prompts to every court model and checks
  JSON validity, schema, latency and refusals.
- [x] **Chaos test** (also MLP1-024): seeded broker faults (5xx, timeouts, lost responses, partial fills) across many
  simulated pulses. The invariants must hold: no orphan, no unprotected position, no double order.
- [x] **Halt / restricted list** (also MLP0-005): Nasdaq trade halts feed, plus Alpaca asset status, as a Tier 0
  filter. This matters once the universe is dynamic.
- [x] **Universe budget guard**: hot-ported symbols are capped (count and TTL), and the free-tier budget doc is
  updated for the wider intake.

---

## C. Dossier export (169 items)

### Pre-sale notes (PSS)
- [=] PSS-001 Constitutional spine: protected as is.
- [=] PSS-002 Synchronous hash chain, reservations and idempotent IDs: protected as is.
- [=] PSS-003 DSR/PBO strategy demotions (ADR-046/055).
- [=] PSS-004 Dark cockpit and court transcripts (ADR-036/044).
- [=] PSS-005 Learning loop waits for data: agreed. Calibration stays shrunk until 50 outcomes.
- [~] PSS-006 Brain.ts is too big: new subsystems go in their own modules (`src/portfolio/`, `src/universe/`,
  `src/research/`), and Brain only wires them. A full split is deferred to a quiet week, because it's high risk for
  no behaviour change.
- [~] PSS-007 19-secret onboarding wall: `pnpm demo` needs zero keys; local mode needs one LLM key.
- [-] PSS-008 Pivot to selling the software: a business decision for the operator, not a code change.
- [=] PSS-009 Free-tier blow-up risk: every new feature is budgeted in `docs/FREE_TIER_BUDGET.md`.
- [=] PSS-010 Goodhart on tiny samples: bandits, prompt tuning and Kelly stay deferred (see below).
- [-] PSS-011 Feature freeze to launch: the operator asked for the build.
- [~] PSS-012 cortexd local daemon + BYOK: built as local mode + OpenAI-compatible BYOK (§A).
- [→B] PSS-013 Co-Pilot: `/roast`.
- [→B] PSS-014 Lateness meter + standing orders: lateness meter and resting convictions, see §B.
- [→A] PSS-015 Thesis falsifiers and exit re-underwriting: the exit engine, see §A.
- [-] PSS-016 Pre-event scenario matrix for <50 ms execution: the pulse is 60 s and free tiers can't do sub-second
  event trading; a $10 ticket earns nothing from speed. Entity anonymizer: see MLP1-018.
- [~] PSS-017 Monkey control group + ghost regret: built as a *virtual* control in the Governor (random entries with
  our exits, our entries with random exits, simulated on bars). Real LAB orders would eat the LAB account's slots.
- [=] PSS-018 Year-two deferrals: agreed for the marketplace and mesh. Widgets ship as menu-bar/tray (§A).
- [-] PSS-019…PSS-028 Commercial items (personas, pricing, Show HN, launch video, revenue): operator decisions, not
  code. The brag video already exists (`brag-output/`).
- [-] PSS-029…PSS-036 Closed-source packaging (Bytenode, Nuitka, Tauri licensing, key proxy): the repo is public;
  obfuscation adds nothing. The useful part, zero-broker-key onboarding, is `pnpm demo`.
- [-] PSS-037…PSS-039 Public demo cockpit and launch hooks: commercial; the public feed (§A) is the honest version.
- [~] PSS-040 Co-Pilot hero position: `/roast` is a top-level command; the web terminal gets a ROAST box.

### Hedge-fund practices (MLP0)
- [→A] MLP0-001 Re-underwriting hearings: the exit engine.
- [-] MLP0-002 Inverse-ETF beta hedging: hedging a $10 position with a $10 minimum inverse ticket doubles costs, and
  inverse ETFs lost net of costs in the backtest lab (ADR-046). Net beta is *measured* in the weekly book review instead.
- [⏸] MLP0-003 Living per-symbol coverage files: comes back after the dynamic universe has run for 2 weeks (needs a
  stable set of covered names). The deep dossier is stored per symbol already.
- [⏸] MLP0-004 Weekly macro house view: comes back once the court has 30 resolved outcomes, so its effect is measurable.
- [→B] MLP0-005 Halt / restricted list.
- [⏸] MLP0-006 Cross-asset lead-lag signals: candidate LAB strategy; needs a backtest first (backtest lab queue).
- [⏸] MLP0-007 Code quant seat (logistic model voter): ≥ 100 labelled contracts (features are logged, W2-33).
- [=] MLP0-008 Calculator tools for advocates: Tier 0 computes all arithmetic into the evidence; checkBull clamps.
- [⏸] MLP0-009 Precedent search: comes back at ≥ 30 graded hearings, when there's case law to find.
- [~] MLP0-010 Distilled Tier 1 classifier: a zero-neuron keyword/source prefilter now (needed for the wider intake);
  the trained TF-IDF model comes back at ≥ 2,000 Tier 1 decisions in `triage_log`.
- [→B] MLP0-011 `/why`.
- [→B] MLP0-012 Drift canary.
- [→B] MLP0-013 Temporal fact sheet.
- [-] MLP0-014 Auto-ingest arXiv into strategies: unreviewed code generation in a trading system. New ideas go
  through the backtest lab by hand.
- [-] MLP0-015 Canary deploy rollback: CI can't deploy at all (no Cloudflare token); deploys are manual.
- [-] MLP0-016 / MLP0-017 ADR drafting and investor letters: the weekly report card covers reporting, and ADRs need
  judgement.
- [~] MLP0-018 Monthly universe review: becomes the dynamic universe's continuous screen (§A).
- [⏸] MLP0-019 Intervention reason classes: matters when LIVE is ratified.
- [⏸] MLP0-020 Operator dead-man switch: LIVE-only; before RATIFY.
- [→B] MLP0-021 Depeg + venue veto.
- [⏸] MLP0-022 Overnight gap budget: at R2 (equities are a small share of trades today).
- [=] MLP0-023 Time-of-day liquidity: typical-spread sampling per symbol (ADR-054).
- [ ] MLP0-024 Equal-risk BTC/SPY benchmark lines on the equity chart.
- [-] MLP0-025 Extracting a governance kernel: commercial.

### Pod architecture (MLP1)
- [-] MLP1-001 Pre-compiled scenario trees: see PSS-016.
- [~] MLP1-002 Mosaic swarm (4 parallel sub-agents): free models share rate limits, so four agents in parallel just
  queue. Built as *phases* in one run with one shared notebook (market → catalyst trace → asset → contradiction hunt),
  with parallel tool calls inside each step.
- [-] MLP1-003 Pair trades: would need shorting or inverse legs; long-only cash at $54.
- [⏸] MLP1-004 Source integrity agent: research already marks unread/invented sources; a domain reputation map comes
  back with Dawid-Skene (≥ 200 graded outcomes per source).
- [→B] MLP1-005 Priced-in auditor: the lateness meter.
- [x] MLP1-006 Dilution detective: research flags S-3, 424B5 and ATM filings in the last 30 days, in code from the
  filing list (dynamic universe brings small caps).
- [=] MLP1-007 Regime meteorologist: regime batches, HMM context, funding (ADR-055).
- [-] MLP1-008 Execution plumber (TWAP/VWAP): $10 orders.
- [→A] MLP1-009 Position warden: the exit engine.
- [=] MLP1-010 Autopsy coroner: Governor postmortems (ADR-030/049).
- [⏸] MLP1-011 Kelly allocator: ≥ 50 trades per strategy.
- [~] MLP1-012 Timestamp verification: research uses tool-reported dates and marks undated findings; the catalyst trace
  finds the earliest report time.
- [→B] MLP1-013 Abnormality z-scores: volume z-score in the lateness meter.
- [⏸] MLP1-014 Catalyst base rates: ≥ 100 graded catalysts.
- [⏸] MLP1-015 Marginal VaR: at R3 (≥ 5 positions). The correlation guard covers 3 slots.
- [⏸] MLP1-016 EDGAR section diffs: comes back after dilution flags prove useful.
- [~] MLP1-017 Sympathy graph: research names related symbols; the scout adds them as watch-only (§A).
- [-] MLP1-018 Backtest look-ahead from LLM memory: our backtests are deterministic rules with no LLM. Comes back if
  a court replay is ever built (the locked-window replay in §D will use anonymised tickers).
- [=] MLP1-019 Split-brain reconciliation: idempotent IDs + lost-submit recovery (ADR-020, ADR-054).
- [=] MLP1-020 Corporate actions: split-adjusted bars in research; universe screen uses `adjustment=all`.
- [=] MLP1-021 Liquidity mirage: limit orders only, price collars, spread gates.
- [=] MLP1-022 Hidden factor stacking: correlation guard (ADR-035); net beta in the weekly book review.
- [⏸] MLP1-023 Court bar exam CI: needs 25 graded historical cases.
- [→B] MLP1-024 Chaos test.
- [~] MLP1-025 Semantic dedup: token-Jaccard near-duplicate check in the prefilter (no embedding model needed for
  headlines).

### Convex payoffs (MLP2)
- [-] MLP2-001 Kalshi / Polymarket: a different broker with KYC, and a new arena in the constitution; operator
  decision.
- [→A] MLP2-002 Hold-or-harvest.
- [-] MLP2-003 Pyramiding: positions already sit at the 35% notional cap with the $10 minimum; there's no room to add.
- [⏸] MLP2-004 Scheduled-catalyst pre-debate: comes back after resting convictions run for a month (same machinery).
- [⏸] MLP2-005 Self-tuning thresholds: ≥ 100 resolved trades (Goodhart, PSS-010).
- [→A] MLP2-006 Universe expansion.
- [⏸] MLP2-007 Thompson bandit allocator: ≥ 50 trades per strategy.
- [⏸] MLP2-008 DSPy prompt evolution: needs the locked-window replay (§D) first.

### Concrete architectures (MLP3)
- [~] MLP3-001 PositionShadowDO per position: one DO per position multiplies requests. The exit engine runs inside the
  pulse instead (§A).
- [⏸] MLP3-002 Three-tranche scale-out: each tranche would be below Alpaca's $10 minimum at $54. Comes back at R2.
- [→A] MLP3-003 Wiretap research: watch dossiers.
- [→A] MLP3-004 Velocity expectancy rotation: opportunity-cost rotation.
- [→A] MLP3-005 News-first hot-porting: the scout.
- [→A] MLP3-006 Dual-ring research: fast and deep dossiers.
- [→A] MLP3-007 Compaction micro-passes.
- [=] MLP3-008 Kronos fusion: forecast block in court evidence (ADR-041).
- [~] MLP3-009 Kronos cone trailing stops: Kronos is LOW-confidence and never trades by itself (operator rule), so a
  p10 breach is a *tripwire* for re-underwriting, not a stop.
- [~] MLP3-010 Encrypted .scar marketplace: `.scar` packs without the marketplace (§A).
- [~] MLP3-011 Sovereign thesis relay: follower mode over the public feed (§A).
- [-] MLP3-012 Local key-signing proxy: commercial-security feature; local mode keeps keys local anyway.
- [~] MLP3-013 Desktop widgets: SwiftBar + Windows tray (§A).
- [~] MLP3-014 Android app: ntfy + PWA (§A).

### Exits and research (MLP4)
- [→A] MLP4-001 Immediate re-underwriting on headlines.
- [→A] MLP4-002 Kill-criteria tripwires.
- [→A] MLP4-003 Regime-adaptive trailing.
- [→A] MLP4-004 Slot rotation.
- [→A] MLP4-005 Weekly book review.
- [→A] MLP4-006 Pre-event de-risking.
- [→A] MLP4-007 Exit grading.
- [~] MLP4-008 Relationship graph: research names related symbols; no hand-kept graph.
- [→A] MLP4-009 Primary-source chaser: the catalyst trace scope.
- [→A] MLP4-010 Contradiction hunter: the research's final phase.
- [~] MLP4-011 Persistent symbol libraries: deep dossiers persist per symbol; full coverage files deferred (MLP0-003).
- [→A] MLP4-012 Multi-angle research: research phases.
- [x] MLP4-013 Stake-weighted research budget: deeper budget for held symbols and high-quality Tier 2 cases.
- [x] MLP4-014 Missed-move forensics: daily scan for ≥ 3 ATR moves in the universe with no court case; journaled
  with the intake stage that dropped them.
- [-] MLP4-015 Social sentiment: X/StockTwits APIs are paid or closed; Reddit's API needs an app and is rate-capped.
- [-] MLP4-016 Live earnings-call audio: paid transcripts, and no tradeable edge at $10 tickets.
- [-] MLP4-017 Strategy-proposer agent: see MLP0-014.
- [-] MLP4-018 DevOps auto-fix agent: unattended code changes to a trading system.
- [→B] MLP4-019 Ask the journal: `/why`.
- [-] MLP4-020 Goal-oriented doctrine synthesis: the constitution is operator-only by design.
- [⏸] MLP4-021 Auto-benchmark router: the drift canary records quality/latency first; reordering comes back after
  4 weekly canary runs.
- [~] MLP4-022 Verified leaderboards: the signed public feed is the verifiable record; no leaderboard without peers.
- [~] MLP4-023 Scar exchange: `.scar` packs.
- [-] MLP4-024 Tournaments, MLP4-025 shared jurors, MLP4-026 bounty marketplace: need a community first.
- [⏸] MLP4-027 Multi-broker adapters: `BrokerApi` is already an interface; a second broker comes back with an
  operator need.
- [~] MLP4-028 Plugin SDK: strategy plugin interface + manifest docs (§A).
- [~] MLP4-029 Telegram/Signal/Watch C2: ntfy alerts (read-only). Remote *commands* stay on Discord (signed).
- [⏸] MLP4-030 Multi-pot constitutions: at R3.
- [⏸] MLP4-031 Encrypted backups: with the hot-state snapshot before RATIFY (FUTURE_PLANS W1-40).
- [~] MLP4-032 Crash replay: worst-case 5-day historical drawdown of the current book in the weekly review.
- [-] MLP4-033 Tax-loss harvesting: paper account and $54.
- [-] MLP4-034 Cash sweep into SGOV/BIL: T+1 settlement would lock the cash the next entry needs (good-faith rule).
- [⏸] MLP4-035 Replay theater: after 30 hearings.
- [=] MLP4-036 Weekly narrative: the Governor's Sunday report card.
- [=] MLP4-037 Explain mode: plain-English guide in the web terminal (ADR-037).

### First principles (MLP5)
- [⏸] MLP5-001 Edge-source tag on contracts: comes back with the next contract schema change (v2).
- [=] MLP5-002 Fund seats: bull, cross-family bear, rebuttal, quant/risk/macro panel, judge.
- [⏸] MLP5-003 ORB/VWAP craft: needs intraday bars in evidence; comes back if equities become the main arena.
- [=] MLP5-004 Inversion defense: invariant monitor in /health (ADR-053), sentinel, fail-closed gates.
- [-] MLP5-005 100 parallel hearings: free-tier RPD caps; the scout widens intake instead.
- [-] MLP5-006 Alt-data scrapers: low signal for multi-day $10 trades, high maintenance.
- [⏸] MLP5-007 Intervention-to-rule compiler: with MLP0-019, at LIVE.
- [-] MLP5-008 Self-revising constitution: the constitution is operator-only (U8).
- [→B] MLP5-009 Lateness meter.
- [~] MLP5-010 Ghost regret dashboard: gate refusals are graded already (ADR-039); the virtual monkey control (PSS-017)
  adds the counterfactual.

### Legal system (MLP6)
- [~] MLP6-001 Crux-first hearings: the research run starts by naming the 2–3 cruxes the case turns on and spends its
  budget on them first.
- [⏸] MLP6-002 Appeals court: comes back after resting convictions (same "re-hear on new evidence" machinery).
- [→B] MLP6-003 Resting convictions.
- [~] MLP6-004 Dual monkey control groups: virtual, in the Governor (see PSS-017).
- [→A] MLP6-005 MFE/MAE horizons.
- [-] MLP6-006 / MLP6-010 Naive-bot consensus fade: a fade needs a short or inverse leg. The long-only version is to
  *not* buy crowded spikes, which the lateness meter does.
- [=] MLP6-007 Corporate-flow calendar: turn-of-month strategy in LAB (ADR-045).
- [-] MLP6-008 Operator friction telemetry: one operator.
- [→B] MLP6-009 Standing orders: resting convictions.

---

## D. FUTURE_PLANS carry-overs

Everything in `docs/FUTURE_PLANS.md` keeps its trigger; none has fired yet (3 days of live data). Two move forward
because the operator asked: the Kronos challenger (as SHADOW, §A) and the per-account local runner (§A).

- [⏸] Calibration per role, conformal abstention, Dawid-Skene, reflection pass, meta-label model, panel switch,
  disagreement tax, locked-window replay, journal replay verifier, repricing ladder, slippage fee override, HMM size
  input, microstructure dataset: data triggers in FUTURE_PLANS.
- [⏸] LIVE-only items (twin divergence breaker, hot-state snapshot, per-capability HMAC, cluster correlation,
  vol-targeted risk): at RATIFY / R2–R3.
- [⏸] Operator items (Healthchecks.io, CI deploy token, D1 retention, ambiguous-grade migration).
- [ ] Options lab realism (per-contract fees, tick size, short-leg DTE blackout): small; done in this round if time
  allows.

---

## Worklog

Newest last. Each entry says what landed, how it was tested, and what's left.

- 2026-10-26: worklog written; every item has a verdict. Build starts with the research desk.
- 2026-10-26: research desk v2 (057) and the dynamic universe + scout (058) landed with tests; prefilter tuned on 6 h
  of real Alpaca news (≈ 20% pass).
- 2026-10-26: exit intelligence (059), entry timing (060), Governor exit scorecard + monkey control + missed moves and
  the /why /roast /book /universe commands (061), monitoring (062) landed with tests.
- 2026-10-26: **direction change (operator):** commercial, closed-source, desktop + local mode + optional own cloud,
  community, paste-to-agent setup, budgets no longer a constraint for paid options. Re-verdicts:
  - BYOK frontier models: now built (063). Local Clef: built as REST + shim (063).
  - Local mode, background runner, desktop app, headless image: built (064, 066).
  - Widgets/Android: the desktop app's tray pill + ntfy + PWA cover it; native mobile stays out (store fees, a second
    codebase) until customers ask.
  - Crowd/copy trading/memory uploading: built as the community hub (068). Marketplace payments, tournaments, shared
    jurors: still need a community first.
  - Closed-source protection (PSS-029…033): obfuscation stays rejected as a moat; the bundle ships no TS source and
    the hub is server-side value. Licensing + signed updates are the next commercial step (docs/DISTRIBUTION.md).
- 2026-10-26: cloud without GitHub: job queue + desktop runner + `cortex deploy` (065), sanity vetoes (067), hub
  (068), Chronos-2 companion (069), drift canary + chaos test (070). The canary found the free court chains fragile
  today (Gemini 503, Qwen JSON/TPM, Nemotron cut off) and the fixes shipped; the chaos test found alert spam.
- 2026-10-26: web-terminal bug found by local mode: every command answered "signed out" (isRevoked null/undefined).
