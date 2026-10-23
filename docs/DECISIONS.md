# Architecture Decision Records

Format: context → decision → consequences. Newest at the bottom. Add one whenever you deviate from
CLAUDE.md or the spec.

## ADR-001 — $0 operating cost is a hard constraint (2026-10-22)
**Context:** Operator: "completely free, no Cloudflare plans." Earlier estimate of the spec's stack on paid
plans was ~$10–17/month (20–30% of capital monthly).
**Decision:** Workers Free + GitHub Actions + free LLM tiers + free data only. No card on file anywhere.
**Consequences:** No Containers, no R2, no Zero Trust, no paid Workers AI overage. Designs must degrade
gracefully when free quotas run out. Any positive expectancy is now net-positive.

## ADR-002 — Alarm-driven polling instead of always-on outbound WebSockets (2026-10-22)
**Context:** Outbound WebSockets keep a DO resident and billed; 128 MB × 86,400 s = 10,800 GB-s/day of the
13,000 free. Exceeding free limits hard-fails operations.
**Decision:** DO pulse via `setAlarm` every 60 s (exposed/in-session) or 300 s (flat). Fills via account
activities cursor. News via REST `since` cursor.
**Consequences:** ≤60 s reaction latency. Broker-side stops become primary protection. Strategies target
24–72 h holds, not scalps. Optional budget-gated "hot mode" later.

## ADR-003 — Plain Durable Objects, not the Cloudflare Agents SDK (2026-10-22)
**Context:** `agents@0.30` depends on esbuild, MCP SDKs, AI SDK peers etc.; Free bundle limit is 3 MB.
**Decision:** `DurableObject` from `cloudflare:workers` with our own small state broadcast.
**Consequences:** Web UI uses a plain WebSocket client (or `partysocket`) instead of `useAgent`.

## ADR-004 — Synchronous risk reservations (2026-10-22)
**Context:** Spec claims DO races are impossible; `await` interleaving makes double-spend of heat possible.
**Decision:** Reserve heat/slots in SQLite synchronously before any await; release on failure; sweep expired.
**Consequences:** Every heat check includes reservations. Property-tested.

## ADR-005 — The DO owns order lifecycle; Workflows only for research (2026-10-22)
**Context:** Spec put order lifecycle in a Workflow; that creates two sources of truth and 10 ms/step CPU.
**Decision:** Order state machine + stops live in the DO. `ResearchSprintWorkflow` is the only Workflow
initially (Governor runs on Actions).

## ADR-006 — Python batch on GitHub Actions instead of porting 85 skills (2026-10-22)
**Context:** Seed repos are maintained Python; Containers are paid; Worker CPU is 10 ms on HTTP/cron.
**Decision:** Port only the hot path to TS (see SKILLS_PORTING.md). Everything else runs upstream Python
in Actions and posts results to `/ingest/batch`.
**Consequences:** Batch latency/jitter (Actions schedules can slip); brain enforces staleness.

## ADR-007 — One brain, two accounts (2026-10-22)
**Context:** Operator wants $54 paper and $54 live at once. Two DOs would double Clef/LLM spend.
**Decision:** One DO thinks once, emits one contract, executes per account with independent sizing,
breakers, dials. LIVE starts at Stop 1.
**Consequences:** A brain bug affects both → sentinel is mandatory; paper↔live divergence is measurable
from day one.

## ADR-008 — Our own calibration instead of trusting Clef probabilities (2026-10-22)
**Context:** Clef is calibrated on its training distribution, not our P&L. RL fine-tuning isn't available.
**Decision:** Isotonic calibration from logged outcomes (`config/calibration.json`, Governor PR); heavy
shrinkage to 0.5 under 50 outcomes; sizer uses `g(p̂)` that gives zero size at p̂ ≤ 0.5.

## ADR-009 — Cross-family bear or no trade (2026-10-22)
**Decision:** Tier 3 requires bull and bear from different model families (doctrine `families`). If the
router can't satisfy it within free quotas, the sprint is rejected and journaled.

## ADR-010 — Governor changes are pull requests (2026-10-22)
**Context:** Spec has in-app ratification. Git gives an audit trail and keeps the constitution untouchable.
**Decision:** Weekly Governor opens PRs against `config/`; CI validates; operator merges; deploy applies.

## ADR-011 — Discord embeds + QuickChart instead of satori/resvg; Discord OAuth instead of Access (2026-10-22)
**Context:** 10 ms CPU + 3 MB bundle on Free; Zero Trust/R2 may require a payment method.
**Decision:** As titled.

## ADR-012 — Two Discord applications (2026-10-22)
**Context:** One app = one interactions endpoint; the kill-switch must not depend on the brain's worker.
**Decision:** CORTEX app → `cortex`; SENTINEL app → `sentinel` (`/kill` only).

## ADR-013 — Options are paper-only until the sizer allows them (2026-10-22)
**Context:** Smallest defined-risk spread risks $15–35; per-trade cap is $1.35 at R1.
**Decision:** Shadow lab only; live unlock is a function of the sizer, not a dollar threshold.

## ADR-014 — TypeScript 5.9 and Vitest 4 (2026-10-22)
**Context:** TS 7 (native) and Vitest 5 are current, but `@cloudflare/vitest-pool-workers@0.23` peers on
Vitest ^4.1 and Wrangler tooling is validated on TS 5.x.
**Decision:** Pin TS ^5.9.3 and Vitest ^4.1. Revisit when the pool supports Vitest 5.

## ADR-015 — Kill flag lives in Workers KV, written only by sentinel (2026-10-22)
**Context:** After sentinel flattens, the brain must not re-enter. Sentinel needs state that survives the
brain being broken; the brain must not be able to clear it.
**Decision:** Shared KV namespace `FLAGS`; sentinel writes/clears `killed` (`/kill`, `/rearm`, auto-kill on
LIVE daily loss or brain death); the brain reads it every pulse (~1,440 reads/day, free tier 100k). A KV read
error is treated as UNKNOWN → no entries.

## ADR-016 — Deterministic strategies emit RULE contracts (2026-10-22)
**Context:** U1 requires a contract for every order, but the Phase 1 baseline has no LLM.
**Decision:** `origin: RULE | COURT`. RULE contracts carry no Clef probabilities; the sizer uses the
strategy's doctrine `prior_win_prob`. COURT contracts must carry Clef probabilities and a cross-family
bull/bear pair. D1 migration 0002 adds the column.

## ADR-017 — Phase 1 cancels stale entries instead of re-pegging (2026-10-22)
**Decision:** Passive entries are cancelled after `max_unfilled_pulses`; no chasing. Re-peg on ATR moves
arrives with urgency-aware court contracts (Phase 3).

## ADR-018 — Paper fee model assumes maker entries, taker exits (2026-10-22)
**Decision:** Every paper fill is charged `fee + paper_slippage_bps` (rounded up to the cent) into
`modeled_cost_cents`; effective paper equity = broker equity − modeled costs, and breakers/sizing/graduation
use effective equity. Exits and stops are always priced as taker.

## ADR-019 — Brain tested in Node with node:sqlite and an Alpaca simulator (2026-10-22)
**Context:** `@cloudflare/vitest-pool-workers` can't easily inject a fake broker into a DO.
**Decision:** All logic lives in `Brain`, which depends on narrow interfaces (`SqlLike`, `BrokerApi`,
`MarketDataApi`, `Notifier`, `D1Like`). Tests run full pulses against `test/sim/FakeBroker.ts`, and outbox rows
are inserted into SQLite with the real D1 migrations applied, so schema drift fails CI. The DO is a thin host,
smoke-tested with `wrangler dev`.

## ADR-020 — Order ids use distinct role letters E/S/X (2026-10-22)
**Context:** The first draft derived the role letter from `role[0]`, so ENTRY and EXIT both produced `E` and an
exit reused the entry's client_order_id. The simulator caught it: Alpaca rejected the duplicate and the brain
adopted the old filled entry as the "exit".
**Decision:** `E` entry, `S` stop, `X` exit, with a regression test.

## ADR-021 — No Cloudflare cron triggers (2026-10-22)
**Context:** The operator's Cloudflare account already uses all 5 free cron slots (another worker,
`mahoraga`). Deploying `cortex` with a cron failed with code 10072.
**Decision:** The brain needs no cron: the Durable Object arms its own alarm in its constructor and every
`/health` call re-arms it. The sentinel has no cron either; `.github/workflows/watchdog.yml` calls
`POST /tick` (bearer `SENTINEL_TICK_SECRET`) every ~5 minutes, so `STALE_ALERT_MINUTES` is 12.
**Consequences:** The independent watchdog runs every ~5 min (GitHub can delay or skip runs) instead of every
minute. If a cron slot frees up, set `["* * * * *"]` in `workers/sentinel/wrangler.jsonc`.

## ADR-022 — Kill switch over GitHub Actions instead of a second Discord app (2026-10-22)
**Context:** ADR-012 planned a separate SENTINEL Discord app; only one Discord app exists.
**Decision:** Sentinel exposes bearer-protected `POST /kill?reason=` and `POST /rearm`;
`.github/workflows/kill-switch.yml` (manual dispatch, works from the GitHub mobile app) calls them. This path
is independent of the brain worker and of Discord. The Discord `/kill` handler stays in the sentinel for the day a
second app is added. Alpaca's own dashboard remains the manual last resort.

## ADR-023 — First sync starts the activity cursor at "now" (2026-10-22)
**Context:** The first deploy replayed the paper account's whole activity history (fills placed by another
process earlier the same day) and raised an alert per fill.
**Decision:** With no cursor, record `ACTIVITY_BASELINE` (count skipped) and start from the current time.
Unknown fills after that point still alert, and unknown open positions/orders still force REDUCE_ONLY.

## ADR-024 — No approve-each-trade mode; LIVE dormant until everything is built and proven on paper (2026-10-22)
**Context:** Operator: "I do not want approve each trade for real money either. Real money only comes after total
implementation and testing on paper trading, which must also be completely autonomous." Supersedes the Stop 1
approval stage in ADR-007 and the spec's autonomy-dial design.
**Decision:** The approval path (pending approvals, Approve/Veto buttons, `decide()`) is removed. Dial stops:
PAPER {0, 2, 4}, LIVE {0, 3, 4}; boot migrates any stored Stop 1. LIVE starts dormant (Stop 0, contracts journaled
as SHADOW). Constitution `max_live_autonomy_stop_without_ratification` = 0, and U8 now states the LIVE gate:
Phases 0–6 complete + ≥30-day fully autonomous PAPER run passing RISK_DOCTRINE §7 + live kill drill + one operator
RATIFY. `#bull-vs-bear-court` gets information cards only.
**Consequences:** No human-in-the-loop trade check exists anywhere, so the deterministic risk engine, breakers,
sentinel and kill switch are the only brakes. LIVE unlock after RED resets it to Stop 0 (fresh RATIFY needed).

## ADR-025 — PAPER self-heals (2026-10-22)
**Context:** A fully autonomous PAPER run can't wait on the operator for routine recoveries.
**Decision:** (1) Entry blocks raised by sync checks (orphan positions/orders, margin multiplier) carry an `auto:`
reason and clear by themselves when the condition is gone. Operator pauses and the starting-equity guard stay
sticky. (2) PAPER RED: flatten, lock, then unlock automatically after `paper_auto_unlock_hours` (24 h; constitution
floor 12 h) once flat, with a machine postmortem. Every RED trip stays in the journal and counts against LIVE
graduation. Constitution U5 rewritten accordingly; LIVE behavior unchanged (operator postmortem only).

## ADR-021 (revised 2026-10-22) — Cron slots restored
The operator deleted the worker that held the account's 5 cron slots. `cortex` runs `*/5 * * * *` (alarm self-heal;
the DO still self-arms on start and on /health) and `sentinel` runs `* * * * *` (per-minute watchdog,
`STALE_ALERT_MINUTES` 8). `watchdog.yml` stays as an independent backup every 30 min. 2 of 5 slots used.

## ADR-026 — Research runs pinned upstream skills as-is in GitHub Actions (2026-10-22)
**Context:** ADR-006 chose Python batch for screeners/regime. The tradermonty skills run standalone with only
`requests` (+ `pandas-market-calendars`, optional `yfinance`), and breadth/uptrend need no key.
**Decision:** `research.yml` clones `tradermonty/claude-trading-skills` at a pinned SHA and runs the scripts
unchanged; `research/cortex_research` only summarizes their JSON, adds OKX funding (Binance is blocked on US
runners), signs with HMAC and POSTs `/ingest/batch`. Exposure-coach also runs upstream (it was planned as a TS
port). FMP free key for FTD/macro/market-top; FRED key stored for the economic calendar. Bumping `UPSTREAM_SHA`
is a reviewed PR.
**Consequences:** No forked logic to maintain; upstream changes arrive only by PR. Item `version` = upstream SHA
and `inputs_sha256` = hash of the upstream output give provenance per batch. A failed upstream skill lowers
exposure-coach confidence instead of failing the job.

## ADR-027 — Tier 1 scores one item per Clef call (2026-10-22)
**Context:** The plan batched up to 16 headlines into one clef-flash state with per-item questions. Live test on
the same GDELT articles:

| Article | alone | in batch of 4 | in batch of 16 |
|---|---|---|---|
| CoreWeave slides on Bernstein downgrade | 0.31 | 0.14 | 0.19 |
| US Treasury rule on China tech investment | 0.24 | 0.09 | 0.15 |
| Diesel prices blamed on Ukraine war | 0.04 | 0.08 | 0.14 |
| Lockheed F-35 deal | 0.08 | 0.10 | 0.13 |

Batching compresses scores toward the mean and changes their order: the other items act as distractors.
**Decision:** `funnel.tier1.batch_max_items = 1`, up to `max_batches_per_pulse = 8` calls per pulse (~1.2
neurons each). Volume is controlled at the source instead (GDELT restricted to major financial outlets,
watched symbols only for Alpaca news).
**Consequences:** ≈ 300–1,500 items/day costs ≈ 400–1,800 neurons, inside the 3,000 tier-1 allocation; the
meter stops tier 1 for the day if it isn't.

## ADR-028 — Court runs in the DO pulse; GDELT as a world pulse; verified provider set (2026-10-22)
**Court placement:** The plan put Tier 3 in a Cloudflare Workflow. All steps are I/O-bound and one sprint takes
~10–60 s, so it runs at the end of a pulse (≤1 sprint per pulse, ≤12/day), after exits and stops. That keeps one
state machine, keeps it testable in Node, and costs ~10 GB-s per sprint. Workflows stay available if sprints grow.
**GDELT:** the DOC 2.0 API returned 429 for every topic from GitHub's shared runners, and the GKG corpus is mostly
local outlets with almost no major financial press. The world job now reads the bulk 15-minute GKG files (no rate
limit) and sends (a) an hourly world-risk pulse — share of articles and tone for conflict, policy uncertainty,
monetary, markets, crypto — stored as regime `WORLD` and fed to Tier 2/court as context, and (b) wire press
releases naming watched companies as triage candidates.
**Providers (live-tested):** Gemini via the Interactions API (`gemini-3.5-flash`, then `gemini-3.8-flash`); Groq
`gpt-oss-120b` / `qwen3.8-27b`; NIM `deepseek-v4.1-flash` / `nemotron-3-ultra-550b`. Bull chain: google → qwen →
deepseek. Bear chain: openai-oss → nvidia → deepseek → qwen, always excluding the bull's family. OpenRouter free
models errored and are not in the chains. `timeout_ms` 60 s.
**Code wins:** `checkBull` rejects briefs whose zone misses the bid or whose stop is < 1.2×ATR, and clips targets to
entry + 3·ATR·√(h/24) before the bear or synth ever see them.

## ADR-029 — Tier 1 is a noise filter; the courtroom is always visible (2026-10-22)
**Context:** After the first live hours the court had never run: Tier 1 had screened 11 items and promoted none.
Observed clef-flash P(material): GDELT noise ≈ 0.12–0.20, borderline headlines ≈ 0.26–0.46, a real BTC crash
headline 0.88. Only ~1 watched-symbol headline per hour arrived, and one of them was re-queued every pulse because
Alpaca's news `start` is inclusive and dropped items weren't remembered.
**Decision:** (1) Tier 1 promotes at P(material) ≥ 0.55 and priority ≥ 1.5 (was 0.70 / 2.0): Tier 2 (Clef 27B)
and the court remain the strict gates and are capped (40 / 12 per day). (2) Intake ids are remembered for 3 days
(`seen_items`, hot schema v2) and the news cursor steps 1 s past the newest item. (3) The universe widens: 13
liquid Alpaca crypto pairs and 12 mega-cap equities (`equities_catalyst`), which also feed EDGAR. (4) Every court
session posts a card to #bull-vs-bear-court (bull, bear, Clef bars, outcome), including declines. (5) `/court
SYMBOL` lets the operator convene a session on demand behind all the usual gates.

## ADR-030 — Governor runs on GitHub Actions and reads the journal over a signed export (2026-10-22)
**Context:** Phase 4 needs offline statistics (rejection grading over hourly bars, isotonic calibration, bootstrap,
BH-FDR) that don't fit 10 ms CPU and shouldn't burn DO duration. `wrangler d1 export` needs a Cloudflare API token
in GitHub, which we haven't issued.
**Decision:** (1) `governor.yml` runs Python daily (06:23 UTC) and weekly (Sunday). It pages through
`POST /governor/export` (HMAC with `INGEST_HMAC_SECRET`, whitelisted tables, `rowid` cursor, ≤200 rows) and
returns results as a signed `governor` batch: append-only grades and postmortems, upserted fitness, and a report
card posted to #governor on weekly runs. (2) Rejections are graded at 24h/72h/7d by the first touch of stop or
target on Alpaca hourly bars; a bar touching both counts as a STOP. (3) Court win-probability calibration pairs
come from COURT trades and VALIDATOR-declined court contracts graded at 72h. Once ≥50 pairs exist, the weekly run
fits an isotonic map and proposes `config/calibration.json` on a `governor/calibration-*` branch. The operator
merges (U8); the brain only trusts a map with `n ≥ min_outcomes_before_trusting`. (4) The LIVE gate (RISK_DOCTRINE
§7 b) is tracked from data: days since the last operator intervention, ≥25 PAPER trades, expectancy, PF, rail
violations, worst daily pulse gap (new DAY_ROLL fields), Brier. (5) The outbox inserts grades with an
`EXISTS` guard on `rejections(id)`, so a bad foreign key is skipped instead of failing (and jamming) the batch.
**Not yet:** source reputation, beliefs with decay, scar-tissue PRs, Monte Carlo beyond the bootstrap.

## ADR-031 — Options shadow lab runs as a Python batch with a virtual D1 ledger (2026-10-22)
**Context:** ROADMAP Phase 5 listed Greeks/spreads/PMCC as `ts-hot` (in the DO). The shadow lab isn't latency
sensitive, a chain scan costs ~6 Alpaca requests per underlying (more than a pulse should spend), and the ported
staskh code is Python. Alpaca allows one paper account per key set, and that one is the $54 PAPER account.
**Decision:** (1) `research.yml` job `options` (14:50 and 19:40 UTC on weekdays) runs
`cortex_research.options.lab`: it reads the ledger via `/governor/export`, marks open trades on the free
**indicative** options feed, closes by rule (target / stop / time / expiry settle at intrinsic), and opens new
structures only during market hours, with spot above SMA50 (all three are bullish), ≤1 open per
strategy×underlying, ≤15 open, ≤6 opens per run. (2) Three SHADOW strategies in doctrine: bull put credit spread
(`vertical_credit`), bull call debit spread (`vertical_debit`) and PMCC (`diagonal`, the ported staskh rubric,
min score 7). `config:build` rejects an OPTIONS strategy whose structure isn't in
`constitution.allowed.options_structures_paper`, and the brain re-checks this on ingest. (3) Fills are
pessimistic: sell at the bid, buy at the ask on every leg, $0.05 per contract per fill. One contract per trade;
results in R = P&L / max loss. Each OPEN records `sizer_permits_live` (max loss ≤ the R1 LIVE per-trade cap):
today that is always false (one SPY spread risks hundreds of dollars against a $1.35 cap). (4) Ledger: D1
`options_shadow` (migration 0003), one OPEN and at most one CLOSE per `trade_id`, append-only triggers. The
brain stores events and posts a card; **nothing in this path can reach an order endpoint**. (5) The Governor
scores lab closes as strategy fitness and tracks the Phase 5 exit (≥30 scored) and the "options live"
criterion.
**Known gaps:** no rolls (the PMCC closes before its short expires); no early assignment model; the indicative
feed may differ from OPRA; no earnings filter (no free calendar we trust).

## ADR-032 — The brain dispatches the batch workflows; GitHub crons are the backup (2026-10-23)
**Context:** GitHub's free scheduler fired nothing for the first ~3 hours, then dropped most slots (first
night: 2 of ~16 watchdog runs, 3 of ~10 research runs). Stale regime/world data blocks entries (U6), so dropped
batches cost trading time.
**Decision:** (1) Each pulse, `dispatchDue` checks `DISPATCH_JOBS` (the same UTC crons as research.yml /
governor.yml; a test fails if they drift) and starts any slot that came due in the last 20 min, through
`POST /repos/{repo}/actions/workflows/{file}/dispatches`. It records the slot in hot KV and journals
`DISPATCH`. A failure alerts once and never blocks the pulse. ~35 calls/day, one subrequest each. (2) Token:
fine-grained, this repo only, Actions read/write, stored as the cortex secret `GH_DISPATCH_TOKEN`. Without it
the dispatcher is off and nothing changes. (3) The GitHub schedules stay. A scheduled run first lists the
dispatched runs from the last 90 min (6 h for the governor) and skips if the brain already started the same
job; `run-name` carries the job for that check. (4) The sentinel is untouched: the safety net keeps its own
minute cron and the 30-min GitHub watchdog.

## ADR-033 — Memory: source reputation → W_rep, scar tissue as a Tier 0 veto, decayed beliefs as context (2026-10-23)
**Decision:** (1) Every court contract now always carries its `catalyst` and `catalyst_source` receipts. The
source key is `news:<provider>` for news and the candidate kind otherwise. Each entry attempt journals
`ENTRY_FACTS` (symbol, arena, strategy, origin, regime posture/score, UTC hour/day, catalyst source, W_rep).
(2) **Reputation:** the Governor scores each source on 30 days of outcomes (closed trades plus 72h grades of
validator-declined court contracts). Weight = 1 + 0.5·E[R]·n/(n+20), bounded to doctrine [0.5, 1.2], and 1.0
until the source has 20 signals. The brain keeps the latest map and passes it to the sizer. The sizer now caps
r_eff at the rung's per-trade risk, so a good reputation can lift a trade toward the cap but never past it.
(3) **Scar tissue:** `config/scar-tissue.yaml` is schema-validated in `config:build` (≥3 cited contracts,
`hard_filter` needs an expression, unique ids, optional `expires`). Hard filters veto before the court is convened
and again before every entry (stage `SCAR`). Unknown facts never match. Context rules go to Tier 2 / the court as
lessons. The weekly Governor proposes two kinds of rule, written to the file on a PR branch: a 30-day symbol
cooldown after ≥3 losses in 14 days with ΣR ≤ −2, and strategy×posture after ≥3 losses with E[R] ≤ −0.5. It
never duplicates an existing expression; the operator merges (U8). (4) **Beliefs:** per symbol and per
strategy×arena with ≥3 closed trades in 30 days; c0 = n/(n+5) ≤ 0.9, 60-day half-life. D1 `beliefs` plus a hot
copy (hot schema v3). Tier 2 and the court get up to 3 with decayed confidence ≥ 0.35, as data.
**Safety:** scars and beliefs can only remove or inform trades; reputation is bounded and rung-capped. None of it
can loosen a constitution or doctrine limit.

## ADR-034 — Web terminal: static assets + `/terminal` login links instead of Discord OAuth; polling, not WebSockets (2026-10-23)
**Context:** Phase 6 asks for a web terminal with parity to Discord. The spec planned Discord OAuth2 and a
hibernatable WebSocket. OAuth needs a redirect URI registered by hand in the developer portal plus a client
secret, and WebSocket messages count against the DO request budget (20:1).
**Decision:** (1) The page is plain static files in `public/`, served by Workers static assets: free, outside the
Worker bundle, no build step. It renders every value with `textContent` under a strict CSP (`_headers`).
(2) **Login:** the operator-only, signature-verified `/terminal` slash command replies privately with a link
`/#login=<token>`. The token is HMAC-signed with `WEB_SESSION_SECRET`, expires in 10 minutes, and is single use
(nonce consumed in the DO). It travels in the URL fragment, so it never reaches server logs. The page exchanges
it for an HttpOnly, Secure, SameSite=Strict session cookie (12 h). Mutations also need an `x-cortex-web: 1`
header. (3) **Parity:** Discord and the web share one command runner (`src/web/commands.ts`); a test fails if a
command exists on one side only. Web actions are journaled as `web:<operator id>` and count as operator
interventions for the LIVE gate, like Discord ones. (4) **Live data:** the Command Deck polls `/api/state` every
15 s while visible. That's one Worker request plus one DO request per poll, about 240/hour while open, well inside
100k/day. (5) **Discord cockpit:** the HUD shows a QuickChart equity line from new hourly equity samples (hot
schema v4). `#agent-terminal` gets one compact message per pulse with that pulse's notable journal events.

## ADR-035 — Spec gap closure: entry guards, earnings calendar, setup screeners, chain verification, shadow twin (2026-10-23)
**Context:** A pass over the 45-page vision document found doctrine settings with no code behind them and spec
features never built.
**Decision:** (1) **Correlation guard** (`sizing.correlation_guard`): before an entry, Pearson correlation of
daily log returns (60 days, aligned by UTC date, ≥20 shared days) against every position already held on that
account; above 0.7 → validator rejection. (2) **72 h earnings blackout** (`execution.earnings_blackout_hours`):
the equity job sends an earnings calendar (Nasdaq public calendar, full coverage, plus FMP free as a backup).
The brain keeps it hot (schema v5). An equity entry with earnings inside the window is rejected, and so is any
equity entry when the calendar is older than 4 days (fail closed, U6). (3) **Re-peg** (`repeg_on_move_atr`)
is removed: the spec re-pegs only `IMMEDIATE` contracts and no strategy emits one, so the code would never run;
unfilled entries are still cancelled after `max_unfilled_pulses`. (4) **Setup screeners:** research job
`screeners` (14:45 UTC daily; crypto only on weekends) runs the pinned Stockbee momentum-burst and
exhaustion-hammer screeners offline on Alpaca daily bars for the tradeable universe. Hits scoring ≥70 skip Tier 1
(they are setups, not news) and queue for Tier 2. The kind `screener:<name>` becomes the reputation key, so the
Governor learns which screener pays. Batches older than `staleness.screener_batch_hours` are refused.
(5) **Chain verification** (spec §8.8): the daily Governor recomputes the entire journal hash chain (links,
hashes, contiguous seq from GENESIS). A break posts to #alarms and journals `CHAIN_ALARM`. (6) **Shadow twin:**
the Governor measures live-vs-paper fill divergence per contract (bps, signed against us) for the R2 gate
(<15 bps); WAIT until LIVE trades.
**Still open:** VCP/CANSLIM/COT/insider-cluster screeners (FMP-quota or data limits), macro event calendar
(FOMC/CPI), implied-move extractor, IV-vs-RV routing, weekend crypto→Monday equity signals.

## ADR-036 — Web terminal rebuilt in React as a dark cockpit (2026-10-23)
**Context:** The operator asked for the web panel in React and to look really good (design skills invoked). The
ADR-034 page was plain static HTML/JS.
**Decision:** (1) `web/` is a React 19 + Vite app built into `public/` (`pnpm web:build`, run by
`deploy:cortex` and CI); still free static assets outside the Worker bundle (~80 KB gzip JS, fonts self-hosted
for the CSP). (2) Visual direction: the operator chose the **dark cockpit (Airbus ECAM)** over the rolled signal-box
direction. Nothing is lit when CORTEX is normal; MASTER WARN/CAUT annunciators light only for real conditions
(`web/src/ecam.ts`, unit-tested): red for RED lock or a lost pulse, amber for breaker bands, reduce-only, pauses,
stale regimes, budget limits, broker faults. Colour is a fixed vocabulary (green normal, amber caution, red warning,
cyan actionable, white labels, magenta targets); B612 / B612 Mono (the Airbus cockpit faces, OFL). (3) Layout:
upper display (equity readouts, drawdown and heat dials, equity trend, memo/alert column), lower display with
six system pages (ACCT, FUNNEL, MEM, OPT, GOV, STS; keys 1–6), ECP key row, and an overhead panel of lit
pushbuttons that stay dark in their normal state. FLATTEN sits under a lift-to-arm guard; the autonomy dial
needs a separate SET, and LIVE ratification needs typed RATIFY. The panel states that every control restarts
the 30-day autonomous clock. (4) `pnpm web:dev` serves synthetic data from `web/mock-api.ts` (`/?empty`,
`/?alert` scenarios); it is never built or deployed. Product truth lives in `PRODUCT.md`; the visual system in
`DESIGN.md`.

## ADR-037 — More opportunity inside the same rails; Discord HUD buttons; in-panel guide (2026-10-23)
**Context:** The operator asked to make the system fully autonomous and enable everything that would make money.
A 24 h production audit showed a working but starved funnel: Tier 1 screened 38 items and promoted none, the
court ran once (a manual `/court`), the baseline watched only BTC/ETH/SOL, and equity entries were correctly
blocked by a REDUCE_ONLY market posture. PAPER was already fully autonomous (Stop 2 and Stop 4 behave the same
in code).
**Decision:** (1) Tier 1 promotes at P(material) ≥ 0.45 and priority ≥ 1.2 (was 0.55 / 1.5). Clef 27B (≤40/day)
and the court (≤12/day) remain the strict gates, and sizing is unchanged. (2) The deterministic crypto breakout
baseline scans all 13 liquid pairs instead of 3. (3) Unchanged, on purpose: every constitution cap, the regime
gate (no equity longs in REDUCE_ONLY markets), options as shadow-only, and LIVE dormant until the gate and the
operator's RATIFY; enabling real money is an operator decision recorded in chat, not a config default.
(4) The Discord HUD carries Pause/Resume PAPER and a two-step Flatten (private confirm button), through the same
command runner as slash commands and the web. (5) The web terminal has an in-panel guide (GUIDE key or "?"): a
spotlight walkthrough of every part of the cockpit in plain English for someone new to trading, offered once on
first visit.

## ADR-038 — Operator fresh start on a new broker account (2026-10-23)
**Context:** The old paper keys began returning 401 at 12:59 UTC (the account was replaced). The operator supplied
a new paper account ($54.00, no history) and asked to reset everything and start fresh.
**Decision:** `Brain.resetAccount(account)` behind the HMAC-signed `POST /admin/reset` (same secret as ingest; never
exposed in Discord or the web). It refuses unless the broker is flat with no open orders. It then wipes that
account's hot trading state (positions, orders, reservations, exits, settlement lots, seen activities, equity
history, activity cursor) and re-creates the account row from the doctrine (HWM, breaker, lock, mode, modeled
costs). The next pulse re-baselines the activity cursor. The journal is append-only (U7), so it is not wiped: it
records `RESET`, and the Governor counts RESET as an intervention, which restarts the 30-day autonomous clock.
Market data, budgets, memory and regime are kept. Keys rotate in four places: cortex secrets, sentinel secrets,
GitHub secrets, local `.dev.vars` (RUNBOOK C).

