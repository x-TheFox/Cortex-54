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

## ADR-039 — Exceptional-catalyst lane through a closed regime gate; gate refusals become measurable (2026-10-23)
**Context:** The operator pointed out that a day-level REDUCE_ONLY posture blocks every equity long, so a huge
same-day catalyst would be missed. The regime gate (FINSABER's lesson: unconstrained LLM traders over-buy in bear
markets) refused at Tier 0 before prices were fetched, so the refusals carried no entry/stop and the Governor could
never grade what the gate cost.
**Decision:** (1) Exception lane (`regime_gates.exception_lane`): when the gate is closed for an ordinary reason
(equities REDUCE_ONLY; crypto composite below 40 but ≥ 25), a catalyst may proceed if Tier 1 rated it exceptional
(P(material) ≥ 0.85 and priority ≥ 2.2). It is flagged with a `regime_exception` receipt, must clear a stricter
Tier 2 bar (long_favored ≥ 0.85; regime alignment waived because it is counter-regime by definition), then the
normal court, and trades at half size (`regimeMultiplier` 0.5 in the sizer, which can only shrink risk) with at most
one exception position open across accounts. (2) Never through the lane: CASH_PRIORITY, crypto below the floor, or
stale regime data (fail closed, U6). (3) Every gate refusal now fetches prices first and records a bid/ATR
hypothetical, so the rejection ledger grades it at 24h/72h/7d; the Governor reports the gate's 72h cost
("positive avg R = the gate is costing money") as evidence for tightening or loosening it by PR. (4) Fix found on
the way: a Tier 2 candidate whose Clef call threw was retried every pulse and blocked the queue; Tier 2 is now one
attempt per candidate, like the court.
**Honest limit:** no filter can both never miss a trade and never take a bad one; the lane trades a small, capped
amount of risk for the big catalysts, and the ledger measures both sides.

## ADR-040 — Profit from falling markets: 1x inverse ETFs and an oversold-bounce strategy (2026-10-24)
**Context:** Since the fresh start (ADR-038) every crypto pair has sat under its EMA20 and the equity posture has
been REDUCE_ONLY, so the long-only breakout baseline and the regime-gated court had nothing to buy. The operator
authorised shorting and bounce trading ("do anything as long as it makes money").
**Broker facts (verified 2026-10-24):** the account is cash (multiplier 1, `shorting_enabled: false`). Alpaca only
allows short selling in margin accounts with ≥ $2,000 equity, and crypto is never shortable. True shorting is
therefore impossible at $54, whatever the constitution says.
**Decision:**
1. Constitution v2 (operator-authorised): U3 now bans *leveraged* products (2x/3x, long or inverse) but permits
   buying the 1x inverse ETFs in `allowed.inverse_etfs_1x` = SH (S&P 500), PSQ (Nasdaq-100), RWM (Russell 2000),
   BITI (bitcoin futures). `config:build` fails if a strategy tagged `instrument: inverse_etf_1x` lists anything else.
   Buying an inverse ETF is still a long, cash-paid, stop-protected position: every other cap is unchanged.
2. `EQUITY_INVERSE_BREAKOUT_V1` (RULE, PAPER): during the regular session, buy an inverse ETF that breaks its
   prior 10-day high and sits above its EMA20 while its regime is bearish — equity posture REDUCE_ONLY or
   CASH_PRIORITY for SH/PSQ/RWM (stale posture → no trade), crypto long gate closed for BITI. Stop 2 ATR, target
   3 ATR, max hold 72 h (inverse funds decay over long holds). The correlation guard keeps SH+PSQ from stacking.
3. `CRYPTO_OVERSOLD_BOUNCE_V1` (RULE, PAPER, 13 pairs): yesterday's RSI14 ≤ 32 or the last 3 closes ≥ 2 ATR under
   the EMA20, and today's bid back above yesterday's high (reversal confirmation) while still under the EMA. Stop
   just under the 5-day swing low (clamped to 1.5–3 ATR), target the EMA20 (clamped to 1.5–3 ATR), max hold 48 h.
   Deliberately not gated on risk-on; skipped while a fresh crypto composite is below 15 (capitulation).
4. Both run hourly, one contract per symbol per UTC day, through the same validator, sizer, fee hurdle, scar tissue
   and breakers as everything else, with the doctrine prior (0.6, conviction 5) until the Governor has outcomes.
5. Research skills retry once after 20 s (a single TLS timeout had dropped a crypto regime batch).
**Revisit:** at ≥ $2,000 equity a margin account would allow real shorts; that needs a new constitution change.

## ADR-041 — Kronos candlestick forecasts as a probability source (2026-10-24)
**Context:** The operator asked to integrate [Kronos](https://github.com/shiyu-coder/Kronos) (MIT), a decoder-only
foundation model pre-trained on candlesticks from many exchanges. It cannot run in a Worker (10 ms CPU, no torch),
and Workers AI does not host it.
**Decision:**
1. A `kronos` research job (`research.yml`, every 4 h at :37, also dispatched by the brain) runs Kronos-small (24.7M
   params) from a pinned checkout on the free GitHub CPU runner. Torch comes from the CPU-only index in a separate uv
   dependency group, so the other jobs stay light.
2. Per crypto pair: 30 days of 4-hour candles (180, inside the 512 context) → 24 independent sampled 48 h paths
   (`predict_batch` with one sample each; `predict` would average them away). 4-hour candles instead of hourly cut CPU
   ~15× (hourly: >10 min for one pair; 4 h: ~18 s).
3. **Volatility rescaling.** Measured 2026-10-24: Kronos's sampled 48 h band on BTC was −0.65%…+0.96% while BTC's
   daily ATR was 2.6%; un-rescaled, no path ever touched a 1.5 ATR stop or target. Path moves are scaled so their
   spread matches realized 48 h volatility (factor clamped to 1–10, never narrowed); direction and shape stay Kronos's.
4. The job reads the stop/target multiples from `CRYPTO_KRONOS_FORECAST_V1` in the doctrine and reports, for exactly
   that trade: p_win (paths ending profitable, first touch else marked at the horizon; same-candle touch = stop),
   p_target_first, p_stop_first, p_up, mean and 10/90% returns. It also keeps the raw (unscaled) p_up and mean.
5. The brain stores the latest batch (whole replace, zod-validated, stale > 5 h refused) and:
   - `CRYPTO_KRONOS_FORECAST_V1` (PAPER): p_win ≥ 0.6, mean > 0, target-first ≥ stop-first, bid within 0.75% of the
     forecast price, not in capitulation (composite ≥ 15). Stop 1.5 ATR, target 2.25 ATR, max hold 48 h.
     `win_prob_used` is p_win **after** `calibrate()` (shrunk toward 0.5 until 50 Kronos outcomes, or the Governor's
     `kronos.p_win` map). The sizer sizes; p_stop_first feeds bear lethality.
   - Court evidence gets a `forecast` block and a `kronos` receipt when a fresh forecast exists for the symbol.
**Honest limit:** Kronos is a pattern model with no news awareness, and 24 samples carry ±0.1 sampling error. The
Governor grades it like any other source; the strategy is demoted by PR if it does not pay.
**Revised the same day (operator):** Kronos must not open trades by itself. `CRYPTO_KRONOS_FORECAST_V1` is SHADOW
(the job still runs; the strategy code stays for a possible later promotion by the Governor). Kronos reaches decisions
only as court evidence: `evidence.forecast` carries `confidence: "LOW"`, an `about` note explaining what Kronos is
and why it is weak, and a one-line `view`. Bull/bear prompts (bull@2, bear@2) and the Clef synth (synth@2) are told
to weigh it lightly and never let it decide. The operator then switched the model to **Kronos-base** (102M params,
same tokenizer and 512 context; ~22 s per pair locally vs ~12 s for small).

## ADR-042 — Venue minimum ticket: lift risk-sized orders to Alpaca's $10 crypto floor inside the caps (2026-10-24)
**Context:** The first Kronos contracts (BTC, DOT) were sized $3.90 and $2.61 — a calibrated-down edge on $54 — and
Alpaca refused both: crypto orders need a cost basis of at least $10 (`403 40310000`). With the doctrine prior and the
calibration shrink, nearly every crypto entry at $54 sizes below $10, so the agent could never buy crypto.
**Decision:** `execution.min_order_notional_usd` = {CRYPTO 10, EQUITIES 1}. When the *risk* cap binds and the order
falls under the venue minimum, the sizer may lift it to the minimum (+0.5%, quantity rounded up) only if all hold:
the lift is ≤ `sizing.min_ticket.max_upscale` (4×) of the risk-sized notional; the lifted order's risk
(notional × d_stop) stays ≤ the rung's per-trade cap (R1: 2.5% = $1.35); and it fits concentration, cash and heat.
Orders bound by concentration, cash or heat are never lifted. Otherwise the entry is refused before submission.
**Effect:** at a ~4% stop distance a $10 crypto order risks ~$0.45 (0.8% of equity), well under the constitution's cap.
The constitution is unchanged; per-trade risk can rise above r_eff up to the rung cap, which is the price of trading
at all on a $54 account. Revisit when equity grows enough that risk-sized orders clear $10 on their own.

## ADR-043 — Clairic catalyst facts for Tier 2 and the court (2026-10-24)
**Context:** The operator asked whether Clairic beats Clef or whether both belong in the system. They do different
jobs: Clef decides among options; Clairic (Cloudflare, preview since 2026-10-19) *extracts* typed values from text with
a confidence each. Live test on an earnings headline: revenue and EPS surprise correct to 0.01 pp (conf 0.33 / 0.94),
guidance 2.8 vs 2.87 at conf 0.10, a weekday mis-dated; 676 input tokens ≈ 6 neurons. Jev (TypeSafe) is a decision
model like Clef, not in our Workers AI catalog and only in paid early access: not used.
**Decision:** once per promoted candidate (cached in hot KV for 48 h, shared by Tier 2 and the court) Clairic reads the
catalyst headline + summary against a fixed, versioned field schema (`facts@1`: entity, event type, revenue/EPS
surprise %, guidance vs consensus %, deal value, stated price move, event date, next-day move estimate). Values with
confidence ≥ 0.8 become `evidence.facts.values` and `fact_*` receipts; lower ones are listed in `facts.uncertain`;
the move estimate is labelled LOW confidence. Bull/bear/synth prompts bumped (bull@3, bear@3, synth@3). Budget: its own
500-neuron slice carved from the reserve, ≤ 60 calls/day. Any failure is cached as "no facts" and never blocks the
candidate (fail soft: the court simply sees no facts block).

## ADR-044 — The court becomes a full hearing: rebuttal, expert panel, and a six-part Discord transcript (2026-10-24)
**Context:** The operator asked for more models in the court ("a lot of people debating it out") and a transcript on
Discord that reads as well thought out. The court was bull → bear → Clef judge, posted as one dense embed.
**Decision:**
1. **Rebuttal.** After the bear, the bull's own model answers point by point, may concede points, may only lower its
   conviction, and may withdraw — withdrawal ends the session (stage REBUTTAL, graded like any refusal). The
   contract uses the revised conviction.
2. **Expert panel.** Three seats in parallel — Quant Analyst (arithmetic, reward:risk, fee hurdle, facts), Risk Manager
   (liquidity, event and correlation risk, scar lessons), Macro Strategist (regime, world pulse, priced-in) — each
   giving stance, confidence and up to three points. Seats rotate through `llm_routing.panel.chain` so they start on
   different models, with a 25 s cap per call (advisory seats are dropped, never waited on).
3. The panel and rebuttal are **advisory**: they reach the decision only through the Clef synth's state (synth@4 is
   told to weigh arguments by evidence, not headcount). Probabilities still come from Clef → calibration; size from the
   sizer (U2 unchanged).
4. **Transcript.** One message, six embeds: docket (catalyst, market, Clairic facts, Kronos view), opening statement,
   cross-examination, rebuttal, expert panel tally, ruling (Clef bars + the risk engine's judgment). Trimmed
   longest-field-first under Discord's 6,000-character limit.
**Live check (2026-10-24, `pnpm court:smoke --post`, never trades):** Nemotron returned no JSON, DeepSeek timed out at
60 s and Qwen failed Groq's JSON validation, so the panel chain is gpt-oss-120b → gpt-oss-20b → Gemini 3.5 Flash. The
re-run on ETH took 48 s: bull (Gemini), bear (gpt-oss-120b), rebuttal conceding two points, panel 1 for / 2 against,
Clef P(win) 14% → no trade.

## ADR-045 — LAB brain: forward-test strategies on a second paper account before they touch PAPER (2026-10-24)
**Context:** The operator created a second $54 Alpaca paper account "for backtesting". New strategies (Kronos, and
the research queue in `docs/STRATEGY_RESEARCH.md`) need evidence before they may trade on PAPER, whose record drives
the LIVE graduation gate. A third `AccountId` would need the D1 journal's `CHECK (account IN ('PAPER','LIVE',…))`
changed — a table rebuild of the append-only, hash-chained journal (U7) — so that path was rejected.
**Decision:** a second instance of the same Brain.
1. `LabCortexDO` (subclass of `AgentCortexDO`, DO migration v2) wires the LAB keys (`ALPACA_LAB_KEY_ID/SECRET`) as
   its "PAPER" broker and data feed, its own hot SQLite, and its own D1 journal `cortex-lab` (same migrations). Its
   journal, contracts, fills and rejections never mix with PAPER's.
2. Doctrine view `labDoctrine()`: only `doctrine.lab.strategies` run, as ACTIVE; every PAPER strategy is off there.
   Now: CRYPTO_KRONOS_FORECAST_V1 (operator rule kept — Kronos still never trades on PAPER; LAB measures it),
   CRYPTO_TREND_V1, EQUITY_RSI2_PULLBACK_V1, CRYPTO_TURN_OF_MONTH_V1 (all SHADOW on PAPER).
3. No AI: Clef, Clairic, the court and dispatching are off in LAB, so it cannot spend the shared 10k-neuron or LLM
   quotas. It receives the crypto-regime, equity-posture and Kronos batches (the router forwards them); not
   world-intel or Governor batches.
4. Same constitution, sizer, validator, breakers and kill flag. Discord: LAB posts only to #agent-terminal, tagged
   "🧪 LAB", never the HUD or briefing channels. The sentinel's FLATTEN ALL does not cover LAB (paper only); the kill
   flag still stops its entries.
5. Graduation: a strategy moves from `lab.strategies` to ACTIVE on PAPER only by PR, once its LAB record (graded the
   same way) and the backtest lab agree.
Also: the Alpaca client now pages multi-symbol daily bars (1,000 rows per page across all symbols silently cut later
symbols short — the same bug the Kronos job hit).

## ADR-046 — Backtest lab: replay every rule strategy with costs; promote the one that passes, demote the losers (2026-10-24)
**Context:** `docs/STRATEGY_RESEARCH.md` put a backtest lab first in the build queue, so no strategy trades PAPER on
reputation alone. Containers are paid; GitHub Actions is free.
**Decision:** `research.yml` job `backtest` (Sundays 07:13 UTC, also brain-dispatched) replays every deterministic RULE
strategy over 3 years of Alpaca daily bars (`research/cortex_research/backtest.py`, parameters read from the doctrine),
charging crypto 0.35% and equities 0.05% per side, filling triggers at max(open, trigger), counting same-bar
stop/target touches as stops, one position per symbol. Each strategy gets the Governor's statistics (expectancy in R,
profit factor, bootstrap p, max drawdown) plus a BH-FDR q-value across all strategies and a first-two-thirds versus
latest-third split. Verdict: PASS (positive, q < 0.1, positive latest third), UNPROVEN, LOSES, TOO FEW TRADES. The
brain stores the report (`backtest:latest`), journals the verdicts and posts a card to #governor.
**First run (2026-10-24, 3 years):** RSI(2) pullback PASS (104 trades, 78% win, +0.27R, PF 2.5, q≈0, latest third
+0.17R); breakout baseline UNPROVEN (+0.05R, latest third −0.04R); oversold bounce −0.08R, crypto trend −0.08R,
inverse ETFs −0.06R, turn-of-month −0.14R: all LOSE.
**Acted on (operator delegated the calls):** EQUITY_RSI2_PULLBACK_V1 → ACTIVE on PAPER (and still in LAB);
CRYPTO_OVERSOLD_BOUNCE_V1 and EQUITY_INVERSE_BREAKOUT_V1 → SHADOW on PAPER, moved to LAB to keep collecting forward
evidence (the backtest simplifies their intraday triggers and, for inverse ETFs, proxies the regime). The baseline
stays ACTIVE as the plumbing strategy but is flagged. The court and Kronos are not replayed.
**Honest limit:** a backtest that agrees with the literature is still a backtest. LAB forward results and live PAPER
grading decide what stays.

## ADR-047 — Panel forecast page: Kronos's sampled future beside the robot's own plan (2026-10-24)
**Context:** The operator asked for the panel to show "what the market might look like" according to Kronos and
"what the robot thinks the market would look like".
**Decision:** the Kronos job also sends, per pair, the last 42 four-hour closes and the 10/50/90% quantiles of its
(volatility-rescaled) sampled closes for each future step (~12 KB per batch). The brain stores them with the forecast
and serves `GET /api/forecast?symbol=` (session-protected, read-only): the Kronos block (fan, p_up, mean, staleness,
the LOW-confidence `about` text) and the robot block — its open position or latest contract for the symbol (entry,
stop, target, the calibrated probability it acted on, bear lethality) and the regime. The web terminal's new FCST page
(key 7) draws both on one axis: price in white, Kronos as an amber band with a dashed middle path labelled low
confidence, the robot's entry/stop/target as cyan/red/green lines, and plain-English text under each.
**Why not a robot price path:** the robot does not forecast prices; drawing one would invent a number it never used.
Its honest "view" is the plan and the probability behind it. Synthetic data for `pnpm web:dev` is in `mock-api.ts`.

## ADR-048 — External audit (CORTEX_MASTER_LEDGER), part 1: safety and 3 a.m. fixes (2026-10-24)
**Context:** The operator supplied a multi-agent audit of the repo ("master ledger": per-file review, a principal
audit PH4, and ~110 improvement ideas). Every finding below was re-verified against the code before acting; several
were stale (no backtest engine — ADR-046 since; panel 2/3 seats failing — fixed in ADR-044) or wrong (see below).
**Fixed (verified bugs):**
1. CSP had no `font-src`, so `default-src 'none'` blocked the self-hosted B612 fonts in production → `font-src 'self'`.
2. Fill-loss window: an activity was marked seen *before* `applyFill`; a throw lost the money event. Now applied
   first, marked seen on success; a failure stops the loop with the cursor before it (retried next pulse), and after 3
   failures it is journaled `ACTIVITY_QUARANTINE` with an alarm.
3. Outbox poison pill: one unbuildable or failing row blocked the D1 audit trail forever. Unbuildable rows are
   quarantined at once (`d1_outbox_dead`, hot schema v6); a failing batch is bisected (≤ 9 D1 calls); a row earns an
   attempt only when other rows in the same flush succeeded (an outage never quarantines good rows) and is quarantined
   after 3, journaled `OUTBOX_QUARANTINE`.
4. Hot-state retention: day/month keys, counters, alert stamps and `court_seen` older than 14 days, failure counters
   older than 30, hot contracts older than 180 days not referenced by a position or open order, and dead outbox rows
   older than 90 days are deleted at each day roll (D1 holds the cold copies).
5. Workers AI calls had no timeout → Clef 45 s, Clairic 20 s (`withTimeout`).
6. Breaker read a non-positive high-water mark or equity (corrupt data) as a 0% drawdown → now ORANGE (no entries,
   no flatten). A real 100% drawdown is still RED.
7. Discord failures were silent → the notifier reports each send; `/health` exposes `discord_fail_streak`; the
   sentinel alerts through its own webhook at ≥ 5.
8. Sentinel flatten was fire-once → while the kill flag is set it re-checks the named accounts and re-flattens up to
   5 times, then escalates every 15 minutes (`KILL DIVERGENCE`).
9. A failing pulse re-armed at the fastest cadence → exponential backoff to the flat cadence.
10. Tier 2 / judge (Clef) exceptions dropped an already-dequeued candidate with no record → a rejection row is
    written (graded later like any refusal).
11. Web: flatten requires `confirm: FLATTEN` server-side; raising LIVE autonomy or unlocking LIVE is refused from the
    web (Discord-signed identity only) — a stolen 12 h cookie can no longer give real money autonomy.
12. Clairic grounding: stated numbers (deal size, quoted move) must appear in the source text and the entity must be
    named there, else the value is demoted to `uncertain` (the audit's largest unchecked injection surface).
13. Kronos `max_forecast_age_hours` 3 → 5 (forecasts every 4 h left a dead hour each cycle). CI jobs got timeouts.
**Rejected after verification:** (a) "heartbeat written at pulse start, so a crash loop looks healthy" — false:
`last_pulse_at` is written at the end of the pulse (after the flush/HUD), so a crashed pulse does go stale; only the
error-backoff part was taken. (b) W2-23 "calibration label bug" — the court's win question is *target before stop*,
so TARGET-only labels match it; relabelling would calibrate a different question. (c) "ci.yml `branches: ain]`" —
already struck by the audit itself. (d) A per-append journal tail ring (W1-04) — ~+1 DO row write per journal row
(tens of thousands a day) for a check the Governor already runs daily over D1; not worth the free-tier budget.

## ADR-049 — External audit, part 2: the learning loop (2026-10-24)
**Fixed / adopted:**
1. Governor proposals were never validated before becoming PRs (GITHUB_TOKEN PRs don't trigger ci.yml) and the branch
   was force-pushed. `governor.yml` now runs `config:build` (schema + constitution checks) and the config, court and
   scar tests on the proposed files before any PR exists; branches are `governor/proposals-<date>-<run id>`, pushed
   without `-f`.
2. A hand-edited scar id like `SCAR-xyz` crashed the whole Governor run → ids are parsed with a strict pattern.
3. Calibration ladder (audit W2-19): unsmoothed isotonic at 50–300 outcomes step-overfits. Below 300 the Governor now
   fits a two-parameter Platt curve on logit(p) (flat at the base rate if the slope isn't positive), serialized as a
   21-point monotone map in the existing schema; isotonic from 300 outcomes. The map records `method`.
4. Kronos weights pinned by Hugging Face revision (only the code checkout was pinned).
5. Panel A/B data (audit W2-01): COURT journal rows now carry each seat's stance/confidence/model and the rebuttal
   outcome, so the panel can later be graded against plain majority votes and the judge alone — and cut if it adds
   nothing for its three LLM calls.
**Deferred, with reasons:** CPCV/PBO and deflated Sharpe in the backtest lab (worth doing; next research pass),
Bayesian source reputation (D-10) and conformal abstention (W2-20) (need graded outcomes that don't exist yet),
belief dedupe/TTL ladders (memory is near-empty), locked-window replay (large; after a month of journaled decisions).

## ADR-050 — External audit, part 3: tests, parameter schemas, documentation (2026-10-24)
**Done:** (1) fast-check property tests (`test/properties.test.ts`, fixed seeds): the sizer never exceeds the rung's
per-trade risk, notional, cash or heat caps across 500 random cases (including ADR-042 lifts); loosening any rung
limit above the constitution always fails the build gate; the breaker never gets more permissive as equity falls; any
appended journal verifies and any one-byte payload change breaks it. (2) Strategy params are zod-checked at
`config:build` (`src/strategy/params.ts`) — a doctrine typo now fails CI instead of producing NaN stops. (3) The
breakout baseline uses completed bars only, identical to the backtest replay. (4) Docs reconciled with the code:
README status; ARCHITECTURE (no `ResearchSprintWorkflow`, no SENTINEL Discord app, in-pulse court, LAB brain, current
Tier 1 bar); DATA_SOURCES (no `DataRouter`); RUNBOOK kill drill via `kill-switch.yml`; CLAUDE.md diagram, Tier 1
bar, RED-unlock floor vs doctrine, prompt and parity wording.
**Not taken from the audit (and why):** splitting `Brain.ts` (large refactor, no behaviour gain now; revisit before
LIVE); per-capability HMAC secrets (needs coordinated rotation across GitHub and both workers; low risk while LIVE is
dormant); external dead-man pings (needs an operator-created Healthchecks.io account); provenance-tainted contract
fields (worthwhile, medium effort; after the panel A/B data exists); participation caps and square-root impact
(irrelevant at $10 tickets); HMM/BOCPD regime features and funding-rate vetoes (research ideas — they enter through
the backtest lab like any strategy).


## ADR-051 — Web research desk: a multi-step research agent feeds the court (2026-10-24)
**Context:** The court argued from a thin bundle (one headline, technicals, regime, Clairic facts) and its models
know nothing after their training cutoffs. The operator asked for an agent with web tools and full multi-step freedom
whose findings go to the court. Verified 2026-10-24: Gemini's Google Search grounding has zero free quota; Groq's
`compound` web-search models are not on this key; keyless DuckDuckGo HTML, Google News RSS, Bing News RSS, Wikipedia
REST and the Jina reader work; NIM `nemotron-3-ultra` answers JSON in ≈3 s; OpenRouter `nemotron-3-ultra:free` in ≈13 s
(most other `:free` models are rate-limited or harness-only); Groq `gpt-oss-120b` caps at 8K tokens/minute.
**Decision:** a micro-harness in `research/cortex_research/deep/` (GitHub Actions, `research.yml` job `dossier`):
- *Agent loop* (`agent.py`): the model drives — each step it thinks, writes notes (claim + source URL + date + stance)
  and picks up to 3 tool calls, or finishes. It is told today's date and that its memory is stale. The harness only
  bounds the loop (22 steps, 14 min, 450K tokens), keeps context small (running notebook + latest results), and when
  the budget ends makes one write-up call from the notebook.
- *Tools* (`tools.py`, read-only): web_search, news_search, read_url (direct fetch, Jina fallback; local addresses
  refused), wikipedia, sec_filings (EDGAR), market_snapshot and company_news (Alpaca, LAB key).
- *Model chain* (`llm.py`): NIM nemotron-3-ultra → OpenRouter nemotron-3-ultra:free → Gemini 3.5 Flash → Groq
  gpt-oss-120b/20b (small prompts only); throttled providers cool down.
- *Code checks* (`build_dossier`): a finding may only cite a URL some tool returned (invented sources are dropped);
  `verified` = the agent read that page; near-duplicates merged; schema-bounded (`DossierPayloadSchema`).
**Brain:** a Tier 2 pass (or `/court`) dispatches `research.yml job=dossier symbol=… context=…` and holds the case in
`court_waits` (hot schema v7) for up to `funnel.research.wait_minutes` (25); the dossier's ingest stores it in
`dossiers`, releases the case, and posts a full 📚 card. The court then sees `evidence.research` — summary, cases,
catalysts, risks and numbered findings (`res_N`, citable receipts) — and the transcript gains a "📚 Research desk
briefing" embed. Fresh dossiers (≤ 12 h) are reused; ≤ 16 dispatches/day. Prompts bull@4, bear@4, rebuttal@2,
panel@2, synth@5 tell every role the dossier is the best view of current events but unverified web text that never
overrides code-computed prices. Nothing in the dossier can size or place an order (U2 unchanged).
**Cost:** $0 — public-repo Actions minutes, keyless web sources, free LLM tiers. ≈ 15–30 LLM calls and ≈ 100–300K
tokens per dossier, almost all on NIM.

## ADR-052 — Kronos forecasts for stocks too (2026-10-24)
**Context:** the operator asked why the web terminal's FCST page showed only crypto. ADR-041 ran Kronos on 4 h
candles, which only exist around the clock for crypto.
**Decision:** the same `kronos` job now also forecasts every stock in the watchlists (crypto proxies, core ETFs,
catalyst mega-caps: 18 symbols) from split/dividend-adjusted **daily** IEX candles (~250 days of context), 2 trading
days ahead, with the same ATR stop/target maths, volatility rescaling and fan chart. Each stock forecast carries
`candle_hours: 24` and `horizon_label: "2 trading days"`, so the court's Kronos line and the FCST page say so; the
picker is split into Crypto and Stocks. Stock forecasts are panel and court context only (LOW confidence, ADR-041):
`CRYPTO_KRONOS_FORECAST_V1` still trades its crypto universe and nothing else. Cost: ~1–2 extra minutes of free CPU
per run (2 steps per stock).

## ADR-053 — Audit ideas, round 1: runtime, operations, operator controls (2026-10-24)
**Context:** the operator asked for every idea in the audit ledger to be considered, not only the bugs.
Every idea got a verdict; what is not built lives in `docs/FUTURE_PLANS.md`. This round
builds the runtime and operations ones.
**Built:**
- **Journal:** the outbox flush is single-flight (W1-06). On boot, an empty hot journal head adopts D1's head instead
  of colliding with it forever (W1-03, journaled `REANCHOR`).
- **Kill switch:** the kill flag is scoped per account (W1-09). A LIVE-only kill (daily loss) no longer stops PAPER
  or the research bed. Unknown payloads still mean "kill everything". `KILL_SEEN` records scope, reason and the
  sentinel's kill id (W1-22, W3-26).
- **Liveness:** the sentinel checks that the next alarm is armed (W1-14). A restored alarm is journaled
  `ALARM_LOST` and counted (W1-15). One structured Workers Logs line per pulse (W1-23).
- **Invariant monitor (W1-39):** every `/health` read runs six SQL checks of the constitution:
  - an order without a contract, or a position without a stop;
  - stale risk reservations;
  - entry orders on a RED-locked account;
  - LIVE autonomy without a ratification on record;
  - a stuck outbox.

  The sentinel alerts through its own webhook. `/health.slo` shows pulse age, outbox depth, budget (actual and
  projected), lost alarms, per-stage failures today and cases waiting for research (W1-13, W1-32).
- **Budget projection (W1-16):** a burst that would exhaust a write or duration budget before midnight goes THRIFT
  early. A projection never forces REDUCE_ONLY.
- **Subrequest meter (W1-18):** an RPC arriving mid-pulse no longer resets the pulse's budget.
- **Cron matcher (W1-19):** per-field bounds; restricted day-of-month and day-of-week OR together (Vixie/GitHub
  semantics). Pinned by a 1,000-case property test against a brute-force reference.
- **Dispatch receipts (W1-07):** a dispatched job whose batch never arrives is journaled `DISPATCH_STALE` and
  alerted once.
- **Deploy lag (W1-08):** batches carry the hash of `main`'s doctrine. A mismatch with the running brain for over
  2 h alerts `DEPLOY LAGGING`. Found while building this: CI's deploy step skips silently because there is no
  `CLOUDFLARE_API_TOKEN` GitHub secret, so deploys run from the operator's machine (RUNBOOK).
- **Tier 1 (W1-20):** an item Clef fails on three times is retired with a rejection row.
- **Operator controls:**
  - the destructive `/admin/reset` route refuses a replayed signed request (W1-25);
  - web logout revokes the session server-side for commands (W1-26);
  - Discord `/unlock` enforces the 50-character postmortem in the form (W3-21);
  - raising LIVE autonomy takes two RATIFYs 10 min – 24 h apart (W3-24);
  - the web terminal ignores stale out-of-order replies (W3-27).
- **Drift tests (`test/docs.test.ts`):** every optional secret is in `.dev.vars.example` and every binding is typed
  (W1-30); the sentinel's vendored `verify.ts` equals the brain's (W1-31); retired doc claims stay retired, CLAUDE.md
  names the latest ADR, and ADR headings are numbered and dated (W1-36, W3-31). The schema comment claiming per-pulse
  journal verification was corrected.

## ADR-054 — Audit ideas, round 2: the court, the risk engine, execution (2026-10-24)
**Court:**
- each provider has a daily call cap under its free RPD, and an exhausted provider is skipped (W2-06);
- a hearing has a 150 s budget: past 40% the rebuttal is skipped, past 60% the panel, journaled `HEARING_DEGRADED`
  (W2-05);
- the bear rotates through three lenses (fundamental skeptic, liquidity & macro, quant & structure) per hearing
  (W2-41, bear@6);
- the judge reads the panel seats in a per-hearing order (W2-02);
- a contested ruling (lethal bear, or a bull who retreated ≥ 2 conviction points) is flagged. Its win-probability
  tax is a doctrine key left at 1.0 (log only) until the Governor shows contested rulings do worse (W2-07);
- numbers an argument states that appear nowhere in the evidence (or in the code-checked trade) are counted per role
  (W2-03);
- every COURT row also carries the decision's cost (LLM calls, Clef tokens, ms) (W1-38/W2-39), the running doctrine
  and constitution hashes (W1-28), and the features a later size model needs (W2-33);
- Clef answers are held to their questions: scores clamped to the scale, unknown choices and wrong types dropped,
  failing closed (W2-09);
- evidence carries FRESH / STALE / OLD for quote, bars, catalyst, research and Kronos, and the court stops before any
  LLM call on a stale quote (W2-40; prompts bull@5, bear@6, rebuttal@3, panel@3).

**Risk:**
- breaker hysteresis: worse bands at once, recovery only after 3 evaluations 0.5% clear of the threshold (W3-01);
- the correlation guard no longer passes silently without bars (it refuses). Unknown correlations, and other
  fail-open branches, are counted in `/health.slo.policy_vacuums_today`. An unknown arena's paper slippage is
  25 bps, never 0 (W3-02);
- costs (fee hurdle, stop distance) use max(current spread, p90 of the last ~40 samples) per symbol (W3-06).

**Execution:**
- broker reads retry twice on 429 / 5xx / timeouts (Retry-After honoured, ≤ 2 s); writes never blind-retry;
- after a timeout or 5xx on submit the brain looks the order up by client_order_id before declaring failure (the
  orphan factory); a 429 on submit is journaled `ORDER_THROTTLED`, not alarmed (W3-11);
- adopted orders re-derive risk from their contract's stop, or count the full notional when no contract matches, so
  heat is never under-counted (W3-15);
- every fill journals realized slippage against its order price; a fill > 75 bps through it journals `BAD_PRINT` and
  alerts (W2-36, W3-09, W3-13).

**Verification:**
- property P5: a KILLED account, a RED/ORANGE band or a REDUCE_ONLY/PAUSED mode never gets an entry through (W3-33);
- an injection regression suite: hostile bull prices are repaired or rejected, contracts never carry a size, and a
  dossier full of instructions is just text (W3-30).

**Found already done while building:** price collars (entries always price at the bid inside the zone) and
crossed-quote rejection. W1-12/W3-34 (field taint) hold by construction, and the injection suite now pins them.

## ADR-055 — Audit ideas, round 3: the learning loop; the rest becomes FUTURE_PLANS (2026-10-24)
**Built:**
- **Governor:**
  - Brier decomposition (reliability / resolution / uncertainty) on the report card (W2-21);
  - calibration pairs purged of overlapping holds per symbol (W2-24);
  - a proposed calibration map must match or beat the incumbent's Brier on the newest 30% of pairs (W2-25);
  - deflated Sharpe required for a PROMOTE? fitness status (W2-28);
  - report lines for panel-majority vs judge accuracy (W2-01), realized slippage (W2-36) and the 72 h cost of
    each scar's vetoes (W2-14).
- **Memory:** symbol beliefs decay over 30 days, strategy beliefs over 60. A belief built from exactly the same
  trades as another is dropped (W2-17, W2-11).
- **Backtest lab:** each strategy gets a deflated Sharpe (trial count = strategies tested), and PASS now also needs
  DSR ≥ 0.95. The lab reports PBO via CSCV on monthly R (W2-27/28). First run: RSI(2) still PASSES (DSR 0.99);
  PBO 0.30.
- **Crypto regime:**
  - OKX perp funding is stored, and a crypto entry is halved while its asset's |annualized funding| ≥ 35%. The rule
    is shrink-only, in code (W2-30).
  - A numpy 2-state HMM on BTC daily returns joins the court's regime context as LOW confidence, with no sizing
    effect (W2-29).

**Stopped here (operator, 2026-10-24):** every idea not built yet — the ones that need data, LIVE or the operator,
small extras, and the ones decided against — is recorded with its trigger in `docs/FUTURE_PLANS.md`. That file
replaces the full per-idea table.

## ADR-056 — Gate review: REDUCE_ONLY stocks at half size, transitional macro input, warm-up floor, court chains (2026-10-26)
**Context:** four days without one automatic court session or PAPER buy. An operator-requested review of every gate
found:
- **Stocks:** SPY sat 1.8% under its high, yet every stock candidate died at Tier 0 because the exposure coach said
  REDUCE_ONLY, which we mapped to *no* entries. The coach's composite (34.4) was dominated by the macro detector's
  label "contraction" scored as a fixed 20 at 25% weight. The detector itself reported a transition zone (moderate
  confidence) on its 1–2 year monthly view.
- **Crypto:** the gates were right. All 13 pairs fell 6–24% in 20 days, Tier 2 refused 18 of 18, and 13 of the 15
  crypto refusals were lower 24 h later, with none reaching a 3-ATR target in 72 h.
- **Sizer:** with 0 graded outcomes, the warm-up floor (0.3) shrank a 0.68 court probability to 0.554. PAPER could
  barely size the trades it needs to learn from.
- **Court bug:** a bull that answered no_trade with prices at 0 failed `BullSchema`, so the router burned every hop.
  Live probe: Gemini 503 at peak, deepseek timeouts, nemotron answering in prose. The hearing ended "no bull"
  instead of "bull declined".

**Decision:**
- **REDUCE_ONLY admits COURT stock entries** (`regime_gates.equity_postures_allowing_entries`) at half size
  (`equity_posture_size.REDUCE_ONLY: 0.5`). Total stock exposure stays under the coach's ceiling
  (`Brain.equityPostureLimits`). CASH_PRIORITY still blocks, stale postures still fail closed, and rule strategies
  are unchanged. The exception lane no longer lists REDUCE_ONLY, since it is a regular posture now.
- **Transitional macro input:** when the macro detector reports its own transition zone at moderate or low
  confidence, the coach receives the regime as transitional (its own baseline, 50) via `payload.macro_for_exposure`.
  The raw report is still stored. The follow-through-day input stays as reported: RALLY_FAILED after QQQ's 6% dip is
  a real reading. Today this moves the composite from 34.4 to 43.8 and the ceiling from 28% to 41%.
- **Warm-up floor 0.3 → 0.5** (`funnel.calibration.warmup_min_weight`), until 50 graded outcomes exist. This is a
  doctrine value inside every constitution cap; LIVE stays dormant.
- **Court fix:**
  - a declined bull parses: placeholder prices are filled, and `checkBull` turns them into "bull declined";
  - the chains drop deepseek (60 s timeouts). Bull: Gemini 3.5 → qwen → Gemini 3.8 → gpt-oss-20b. Bear: gpt-oss-120b
    → qwen → Gemini 3.5 → nemotron.

**Kept:** the constitution, crypto gates, Tier 2's bar, breakers, long-only, and the losing bounce and inverse-ETF
strategies staying in the LAB.

## ADR-057 — Research desk v2: wide steps, two scopes, compaction, fast and deep rings (2026-10-26)
**Context:** the operator asked for no 3-tool-call limit, research that covers both the general news and the story
behind the triggering headline, automatic compaction, and permission to run long since research is the system's main
window on the world.
**Decision:**
- Up to 8 tool calls per step, run in parallel (`Limits.max_actions_per_step`, thread pool).
- The first step is seeded by the harness with one search per scope: MARKET (section headlines + market news),
  CATALYST (the triggering headline), ASSET. Notes carry a scope; the agent names 2–3 cruxes first; the first
  "finish" is held back once for a CONTRA hunt.
- Compaction at 55% of the main models' context: the model writes a digest; code keeps only digest items whose URLs
  and numbers appear in the notes they replace. All notes stay in memory for the dossier.
- Two rings: the fast dossier posts for the court (which waits ≤ 25 min as before); the run continues up to ~2 h
  (`depth: deep`) and posts a deep dossier that replaces it. Depth is stake-weighted (Tier 2 quality ≥ 90 or exception
  lane → deep). Watch mode researches held positions against the bear's kill criteria.
- The dossier gains market_context, catalyst_trace (origin URL only if a tool returned it), cruxes, related symbols,
  code-computed filing flags (S-1/S-3/424Bx in 30 days, 8-K in 3 days) and a watch-mode thesis status.

## ADR-058 — Dynamic universe and the scout (2026-10-26)
**Context:** "every symbol can be watched and traded"; a scout ports symbols in when news is promising.
**Decision:** the whole Alpaca news stream is intake behind a zero-neuron prefilter (catalyst words vs wire noise,
near-duplicate check, a daily cap on non-watchlist headlines). When a catalyst about an unknown symbol passes Tier 1,
the scout screens it in code (tradable, active, fractionable stock, not OTC, no leveraged/inverse/volatility name
unless the constitution lists it, no stablecoin, ≥ 30 daily bars, dollar volume and spread floors measured on Alpaca's
venue / the IEX feed) and hot-ports it as TRADE for 7 days (renewed by new catalysts, kept while held). Refusals are
cached for a day. Research-named related symbols are WATCH (news priority, no trading without their own catalyst).
Hot-ported stocks need a whole-market earnings calendar (`coverage: all`, next 4 days, Nasdaq complete) or they fail
closed. LAB keeps the watchlists only.

## ADR-059 — Exit intelligence (2026-10-26)
**Context:** "90% of IQ is spent on entry". Exits were three fixed rules.
**Decision:** MFE/MAE per position; breakeven + fees at +1R, ATR chandelier trail from +1.5R (tighter when the regime
closes); hold-or-harvest at the target (trail for ≤ 48 h past the horizon only while regime, EMA20, RSI < 78 and Kronos
agree); tripwires (regime flip since entry, Kronos p10 breach, funding stress, a WEAKENED/BROKEN watch dossier, a
material headline about the held symbol) trigger one Clef re-underwriting call → HOLD/TIGHTEN/EXIT, code sets every
price; equities are sold before earnings inside the blackout; a stagnant position (≥ half its horizon, |R| < 0.25) can
be released for a stronger waiting court contract. Stops only ever move up. LAB keeps plain exits as a control. The
Governor grades exits (capture, give-back, left on the table, saved) separately from entries.

## ADR-060 — Entry timing: lateness meter, resting convictions, temporal fact sheet (2026-10-26)
**Decision:** Tier 0 measures the move since the headline on hourly bars in daily ATRs (plus pre-drift and volume
ratio); ≥ 0.8 ATR is LATE and refused (graded like other refusals). Court contracts blocked only by "price ran past the
zone" or "max positions" rest for ≤ 48 h (and ≤ half their horizon), re-checked every pulse with every gate. Evidence
opens with today's date, weekday and US session.

## ADR-061 — Governor exit scorecard, virtual monkey control, missed moves; operator commands (2026-10-26)
**Decision:** the Governor simulates two control groups on the same bars (random entries with our geometry; our
entries with random exits) and reports the entry and exit edge, plus watchlist moves ≥ 3 ATR that never reached Tier 0.
New commands on Discord and the web terminal: `/why` (a deterministic decision trail from the journal), `/roast`
(the court judges the operator's own idea; never a contract or an order), `/book` (weekly review: R, age, correlation,
net beta to BTC/SPY, crash replay), `/universe`.

## ADR-062 — Monitoring surfaces (2026-10-26)
**Decision:** ntfy phone pushes for alarms, fills/exits, rulings, reviews and weekly cards (topic = secret);
`/pill` read-only status with a bearer token for the SwiftBar (macOS) and PowerShell tray (Windows) widgets; the web
terminal is installable as an app (manifest + pass-through service worker; CSP allows manifest/worker from self).

## ADR-063 — BYOK models and portable Clef (2026-10-26)
**Decision:** Claude (official SDK, `claude-opus-5-5`, server-side refusal fallback on), OpenAI, a local Ollama model
or any OpenAI-compatible endpoint lead the court chains when the user brings a key (`llm_routing.byok`); without keys
the free chains run as before. Clef runs outside the Worker through the Workers AI REST API, or through a shim that
answers Clef's question format with any chat model (answers pass the same conformance check).
**Revised the same day:** BYOK became the model pool (ADR-072); Clef/Clairic run only on the user's Cloudflare AI, with
a structured stand-in when it is missing (ADR-072).

## ADR-064 — cortexd local mode (2026-10-26)
*Superseded in part by ADR-083: local mode now accepts live keys (LIVE joins at Stop 0 and trades only after RATIFY).*
**Decision:** the same Brain runs in Node: SQLite files for hot state and the journal (same migrations), a keyless
sandbox broker on live public crypto prices (demo) or the user's own Alpaca paper account, research jobs as local
`uv` subprocesses (no GitHub), the web terminal on localhost, a background service (launchd / systemd user unit /
logon task) and the `cortex` CLI (`setup`, `doctor`, `start`, `demo`, `link`, `service`, `kill`, `rearm`, `--json`
everywhere). LIVE keys are not accepted in local mode. Fixed on the way: `isRevoked` compared `null` to `undefined`,
so every web terminal command answered "signed out".

## ADR-065 — Cloud mode without GitHub: job queue, desktop runner, `cortex deploy` (2026-10-26)
**Decision:** `RUNNER_MODE=queue` puts the brain's batch jobs in a hot queue that a linked desktop (`cortex runner`)
claims over an HMAC-signed endpoint and runs locally. `cortex deploy` provisions D1, KV, the brain and the sentinel in
the user's own Cloudflare account. Because a deploy uploads the (minified) code to the customer's account, it is an
advanced option, not the product default (see docs/DISTRIBUTION.md).

## ADR-066 — Desktop app and headless image (2026-10-26)
**Decision:** a Tauri v2 shell runs the bundled `cortexd.mjs` on a shipped, checksum-verified official Node runtime,
opens the cockpit with a one-time login, keeps a tray pill (equity, positions, pulse; kill switch and re-arm), hides to
the tray on close, and the daemon exits with the app. The product bundle ships no TypeScript source. A Dockerfile runs
the same bundle headless.

## ADR-067 — Sanity vetoes (2026-10-26)
**Decision:** new crypto entries are refused when USDT or USDC is > 50 bps off $1 or Alpaca's mid is > 1% from
Coinbase's; stock entries are refused while Nasdaq's halt feed shows the symbol halted. Unreachable sources are counted
as policy vacuums and don't block (the validator's own quote gates still fail closed).

## ADR-068 — Community hub (2026-10-26)
**Context:** commercial direction: a community, shared memory, copy trading, leaderboards — without hosting anyone's
broker keys or code.
**Decision:** a small hub Worker the publisher hosts. Agents identify by their own Ed25519 key; they publish signed
batches of public journal rows (contracts, rulings, exits, excursions, reviews) whose hashes the hub recomputes; heads
can't go backwards and published rows can't change. A leaderboard ranks agents with ≥ 5 closed trades. Following an
agent turns its court approvals into Tier 2 leads for the follower's own funnel (never orders). Memory packs (scar
rules + beliefs) are signed; importing stages a proposal that only `cortex memory apply` merges, beliefs at half
confidence. Scar rules only ever remove trades.

## ADR-069 — Kronos companion: Chronos-2 (2026-10-26)
**Decision:** Timer-S1 (8.3B MoE, non-commercial paper licence) is not usable in a sold CPU product; Chronos-2
(Apache-2.0, 120M, CPU ≈ 0.2 s per series) runs beside Kronos in the forecast job. Its p_up and quantiles are stored
and shown as a SHADOW second opinion only, until the Governor has graded both on the same outcomes.

## ADR-070 — Model drift canary, chaos test, and what they found (2026-10-26)
**Decision:** a weekly workflow sends the same golden bull prompt to every court model and records answered / schema /
latency. Its first run found Gemini 3.5 and 3.8 both 503, Qwen failing Groq's JSON validation and TPM cap, and Nemotron
cut off mid-reasoning at 1,500 tokens. Fixes: NIM gets a 4,096-token output floor (4/4 valid after), the OpenAI-compatible
provider retries once without JSON mode on Groq's validation 400, and the chains are ordered so a cross-family pair
exists when only Groq gpt-oss and NIM answer. A seeded chaos test (random 5xx, lost order responses, failing cancels
across hundreds of pulses) checks the money invariants; it led to broker-sync alerts firing only after 3 failed pulses
in a row (69 alerts in 6 simulated days before).

## ADR-071 — The app is the dashboard; Discord is optional (2026-10-26)
**Context:** commercial product: the desktop app and its panel are what people use. Discord was the dashboard
(alerts, court transcripts, commands), which a non-technical buyer shouldn't need.
**Decision:** every card the brain posts also lands in a hot-store inbox (`InboxNotifier`, hot schema v9, bounded to
3,000 rows / 30 days) that the app's FEED renders; the live HUD is not kept (the cockpit is its live version). ASK
carries why / court / roast / book review / watchlist. Replies that named Discord channels now name the feed. Discord
connects from a bot token alone (`src/discord/setup.ts`: category, channels, invite link when needed; the operator's
script uses the same code plus the sentinel webhook and slash commands). LIVE autonomy and LIVE unlocks are allowed
from the app on a session signed in within the last 10 minutes (RATIFY and the cooling-off unchanged); before, they
were Discord-only.
**Cost:** one hot-store row per card (~100–300/day), far inside the DO's 100k rows written/day.

## ADR-072 — The model pool, and Clef/Clairic only on Cloudflare AI (2026-10-26)
**Context:** operator: users bring any number of endpoints, free or paid, round robin across all models with
fallbacks; warn when only one model exists. Separately: no local Clef; Clef and Clairic need a Cloudflare AI key, and
without it an LLM answers in their exact structure.
**Decision:** `src/court/pool.ts`. The pool is the built-in free providers (their doctrine-verified models, families
and daily caps) plus the user's endpoints (`LLM_POOL` secret in the cloud, `llm` in the local config). Order: free
first / paid first / mixed; round robin rotates the bull and bear chains within each tier group on every hearing
(other chains, like the rebuttal pinned to the bull's own model, run as given); the bear starts one step further
round. Families: lineages when the pool has several (the strongest independence), each model its own family when it
has one lineage; the same model on two endpoints counts once. One model total blocks the court until the user adds a
second or accepts the same model on both sides (then a `~bear` alias with its own family; the warning stays). A model
that is rate-limited or times out sits out for 5 minutes. OpenAI-compatible endpoints adapt to servers that reject a
parameter (JSON mode, temperature, `max_tokens` → `max_completion_tokens`); Anthropic-compatible endpoints get the
server-side refusal fallback only on api.anthropic.com with a supported model (it would 400 elsewhere). Model
discovery: OpenAI `GET /models` (retrying with `/v1`), Anthropic Models API via the SDK. Clef/Clairic in local mode:
Cloudflare Workers AI (REST) when its key is set; otherwise `ShimClef`/`ShimClairic` on the pool's best model, with a
JSON schema built from the questions/fields and the same validators; every surface says performance is marginally
lower. The two-endpoint BYOK built earlier that day is gone (never released).

## ADR-073 — First-launch onboarding, live settings (2026-10-26)
**Decision:** a local brain that hasn't been onboarded opens a welcome screen with two paths: a five-step wizard
(account, AI models, Cloudflare AI, alerts, done; each step is the same component as SETTINGS) or a prompt to paste
into any agent that runs commands (`local/agent-prompt.ts`, identical to docs/SETUP_WITH_AN_AGENT.md, test-enforced).
Settings save to config.json and reload the brain in-process (same port, same session secret); the CLI also watches
config.json, so an agent's `cortex llm add` / `cortex setup --set …` apply live. New CLI: `cortex llm list|add|remove|
models|prefs`, `cortex setup --onboarded`. Keys never go back to the browser (only "…last4"). Local sessions last 30
days (cloud 12 h). The cockpit gains TODAY, one plain sentence on top of ACCOUNTS.

## ADR-074 — The court waits for deep research; the product's support and safety net (2026-10-26)
**Context:** operator: the court should hear the deep dossier and use the fast one only when the deep run is slow.
A re-review of every idea for the app-first objective found the research desk ignored the user's model pool, and
that a sold product needs a way to ask for help and to recover from a bad cloud deploy.
**Decision:** dossiers carry `complete`; the early fast ring is `complete: false` and only shortens the court's wait
to `funnel.research.deep_wait_minutes` (12) after dispatch; a complete dossier releases at once; a late partial never
replaces a complete one. The research desk reads `LLM_POOL` (the user's order; Anthropic-compatible endpoints via the
official Python SDK). `cortex support` / SETTINGS → HEALTH write a redacted support file (key names, never values;
test-enforced) and show the doctor's checks in plain words (`local/health.ts`, shared). `cortex deploy` verifies the
new brain answers /health with this build's constitution and runs `wrangler rollback -y` if it doesn't. SETTINGS shows
a 7-day model scoreboard from `llm_calls`. Remaining re-verdicts are planned in docs/IDEAS_WORKLOG.md §F.
**Addendum 2026-10-27 (live funnel review):** in 3 days PAPER placed no orders. 97 promoted headlines → 77 stopped at
Tier 0 (stale or REDUCE_ONLY equity posture, stale quotes, bearish catalysts) → 23 reached Tier 2 → 0 passed. Crypto is
in a drawdown (BTC under its EMA20, every pair 7–27% under its 20-day high), so the long-only breakout is correctly
idle. One bug: `min_structural_score` 78 on a 5-level score (0/25/50/75/100) meant "Excellent only"; now 70.


## ADR-075 — Paid-model cost meter, spend caps, demote, court capacity (2026-10-27)
**Context:** IDEAS_WORKLOG §E/§F: users who add paid models need to see and bound what they cost, drop a model that
does badly without deleting it, and let the court hear more trades when quotas are no longer the limit (MLP5-005).
**Decision:** endpoints may carry `price_in` / `price_out` (USD per 1M tokens) and `daily_spend_cap`. The router counts
tokens per provider per UTC day through the brain's gate (hot `settings` rows, so a restart doesn't reset the cap;
providers that report no usage are estimated at ~4 characters per token) and skips a provider once its cost reaches
the cap; the rest of the pool carries on. The scoreboard shows 7-day cost per model and a DEMOTE / RESTORE switch
(`prefs.demoted`, `provider/model`); demoted models leave the rotation and the pool notes say so. Local config
`court.max_per_day` (1–60, default the doctrine's 12) overrides `funnel.tier3.max_sprints_per_day` and lifts the
research dispatch cap with it; SETTINGS estimates the daily cost from the scoreboard's tokens and prices. The local
cockpit's third gauge is AI USE TODAY (calls against each provider's daily cap; `StatusView.modelUse`) instead of the
Cloudflare FREE TIER gauge, which means nothing on the user's own computer. Hearings never make a trade bigger.

## ADR-076 — Keys in the OS keychain, encrypted backups, phone access, reset, tray health (2026-10-27)
**Context:** IDEAS_WORKLOG §E/§F (MLP3-012, MLP4-031, MLP4-029, settings export, "reset this computer", tray health).
**Decision:** `secret_store: "keychain"` moves every typed key out of config.json into the OS store (macOS Keychain via
`security -i`, value on stdin; libsecret via `secret-tool`; Windows DPAPI per user), written before the file loses
them; generated local secrets (session, ingest, the tray's pill token) stay in the file. `cortex backup [--keys]` /
SETTINGS → BACK UP write one passphrase-encrypted file (scrypt N=2^15 → AES-256-GCM) with the settings, consistent
`VACUUM INTO` copies of the hot store and journal, and applied memory packs; keys only when asked. Restore keeps this
computer's own secrets, port and network setting, swaps the files with the brain stopped, and starts a paper backup
without its Alpaca keys in demo mode. Phone access (`lan.enabled`, off by default) listens on the local network over
plain HTTP; a phone signs in once through a QR code (encoded in the browser) and may watch and use the controls, but
settings and keys can only change from the computer itself (403 for non-loopback settings writes); the session cookie
drops `Secure` only in this mode. Phone alerts show their ntfy topic as a QR code too. Reset needs the typed word
RESET, then stops the brain, removes the service and the keychain item, and deletes the CORTEX home (the broker account
is untouched). `/pill` carries the one-line problem from the runtime checks, the kill switch, the licence or a
blocked pool; the desktop tray shows it as ⚠ next to the icon and as a menu line.

## ADR-077 — Releases: every platform, changelog, signed auto-update, licences, demo cockpit (2026-10-27)
**Context:** operator: an app build and auto release with generated changelogs for all supported platforms; §F
PSS-029…036 (licensing, signed updates) and PSS-037…039 (public demo cockpit).
**Decision:** `.github/workflows/release.yml` runs on every merge to main that touches the app (or by hand with a
minor/major bump): `scripts/changelog.ts` picks the next version from the latest `vX.Y.Z` tag and writes notes grouped
from the commit subjects; a draft release is filled by a matrix build (macOS arm64 and x86_64, Linux x86_64 and arm64,
Windows x86_64: dmg, app bundle, msi, NSIS installer, AppImage, deb, rpm), the demo cockpit zip, and `latest.json`
for the Tauri updater; it is published once at least one platform built. Updater bundles are signed with a minisign
key whose public half is in `tauri.conf.json`; the private half is the `TAURI_SIGNING_PRIVATE_KEY` repository secret
(without it the installers still ship, but installed apps don't see the release). The app checks at launch and every
6 hours and offers the update in the tray; nothing installs without a click. Apps are not code-signed or notarized
(an Apple developer account costs money, so that's the operator's call); the notes say how to open them.
Licences (`local/license.ts`) are Ed25519-signed JSON checked offline against a publisher key baked in at build time
(`CORTEX_LICENSE_PUBKEY` repository variable; unset = builds that never check, like this public repo's). Without a
valid licence demo mode works and paper mode holds new entries exactly like the kill switch, so every open position
keeps its stop and exits; nothing unsafe ever follows from a licence problem. `scripts/license.ts` makes the publisher
key and issues licences. `pnpm web:demo` builds the panel as static files that answer the API in the browser from the
same fixtures as `pnpm web:dev` (the production build leaves that code out).

## ADR-078 — Broker conformance suite; Brain.ts split begins (2026-10-27)
**Context:** §F: MLP4-027 multi-broker adapters (customers Alpaca doesn't serve) and PSS-006 (the 6,900-line Brain.ts
is a delivery risk for a product team).
**Decision:** `src/broker/registry.ts` lists the venues CORTEX trades through with their capabilities, and
`test/broker-conformance.test.ts` is the contract every adapter must pass unchanged: idempotent client order ids,
lookups by client id, refusing to sell more than is held, cancels, fills as activities. It found the local sandbox
broker accepted a sell with nothing held and reported a sale larger than the position; it now refuses both, like
Alpaca. A second venue joins only after its adapter passes the suite and a supervised paper session against the real
venue; the candidates and what each lacks (no paper mode, or an account to run the session) are listed in the
registry, because an unverified adapter in the order path would be trading on a guess (U6). Brain.ts: the cards and
terminal lines (~700 lines of pure rendering) moved to `src/cortex/cards.ts` (re-exported, so importers didn't
change); the next modules follow the same way, one per quiet change, behind the simulated-pulse tests.

## ADR-079 — MSIX, Apple notarization path, licence key live, demo cockpit on Pages (2026-10-27)
**Context:** operator: do the optional release steps (everything except a Windows code-signing certificate) and ship
an MSIX too.
**Decision:** the Windows release job also builds an MSIX (`scripts/msix.ts`): the MSI is unpacked with an
administrative install, an AppxManifest (full-trust desktop app, internet + private network) and the tile logos are
added, and the SDK's makeappx packs it. With no certificate it is unsigned: the publisher carries Microsoft's
unsigned-package OID so Windows 11 installs it with `Add-AppxPackage -AllowUnsigned`; a Store submission sets
`MSIX_PUBLISHER` / `MSIX_NAME` from Partner Center and the Store signs it. An app running from a package
(`\WindowsApps\`) turns its own updater off, because it would install a second copy; the next MSIX is the update.
macOS jobs sign and notarize when the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID` secrets exist (an Apple Developer account, the
operator's purchase); without them the build is unchanged and the notes say how to open an unsigned app. The publisher
licence key now exists (private half only on the operator's machine, `~/.cortex-publisher/`); its public half is the
`CORTEX_LICENSE_PUBKEY` repository variable, so release builds check licences from the next release on, and the
operator holds a perpetual publisher licence. GitHub Pages serves the demo cockpit (https://x-thefox.github.io/Cortex-54/),
redeployed by every release.

## ADR-080 — macOS bundles are sealed with an ad-hoc signature (2026-10-27)
**Context:** v0.1.1's macOS app opened as "“CORTEX-54” is damaged and can't be opened". Its main binary carried only
the linker's ad-hoc signature with no sealed resources (`codesign --verify`: "code has no resources but signature
indicates they must be present"), and macOS treats a quarantined download with a broken signature as damaged.
**Decision:** `bundle.macOS.signingIdentity: "-"` makes the bundler sign every binary and then the whole bundle
(sealed resources), with the hardened runtime and `entitlements.plist` (JIT and unsigned executable memory for the
bundled Node/V8, network client and server). Verified: `codesign --verify --deep --strict` passes, the bundled Node
runs under the new signature, and a quarantined copy keeps a valid signature. Gatekeeper then shows its normal
"can't verify the developer" prompt (System Settings → Privacy & Security → Open Anyway) until the Apple secrets of
ADR-079 make releases notarized; `APPLE_SIGNING_IDENTITY` replaces the ad-hoc identity in CI.

## ADR-081 — Any account size, account switches, margin accounts, no Cloudflare meter on your computer (2026-10-27)
**Context:** the operator connected the app to a default Alpaca paper account ($100,000, margin enabled). The cockpit
said "SINCE $54 +$99,946", the BTC benchmark started at $54 (the demo's history from before the switch was still in
the hot store), and the account never traded: the margin multiplier and the "equity ≫ doctrine start" check both held
it reduce-only. Separately, local mode showed and enforced Cloudflare free-tier quotas that don't exist on a
user's computer.
**Decision:** each account's start is its equity when CORTEX first saw it (or since its last fresh start), stored in
the hot store and sent as `startUsd`; the cockpit, TODAY and the guide use it. A different broker account behind the
same slot (Alpaca `id` changes: demo → paper, new keys) starts the account fresh (positions, orders, history; RESET is
journaled); a first run on a home whose history is ≥ 2× off the account and holds no positions does the same. Local
mode trades the account the user connected, whatever its size (`adoptAccountSize`), inside the same percentage
limits; the cloud keeps the fail-closed check. A margin account stays reduce-only (U3) unless the broker's own
configuration caps borrowing at 1x (`/v2/account/configurations`, re-read every 30 min): SETTINGS offers "Make it
cash-only", which sets `max_margin_multiplier: "1"` and `no_shorting: true` at Alpaca (it only ever tightens) when
the user presses it. The free-tier meter has a scope: the cloud meters every Workers Free quota; local mode meters only
the user's own Cloudflare AI allowance when Clef runs there, and nothing when an LLM stands in; the STS page, the
status memo and the guide say which.

## ADR-082 — Outside links open in the system browser (2026-10-27)
**Context:** in the desktop app, the setup guide's links (key pages, Alpaca, ntfy, Cloudflare) did nothing: they open
a new tab, and the app's window can't open windows.
**Decision:** the shell builds the main window itself with navigation and new-window handlers: the cockpit (the
bundled page and the local brain on 127.0.0.1 / localhost) stays in the app; every other http(s) or mailto link opens
in the user's default browser (tauri-plugin-opener, called from Rust, so the page gets no new permissions); anything
else is ignored. A unit test pins which URLs count as local (`127.0.0.1.evil.example` doesn't).

## ADR-083 — Live accounts in the app; ratify whenever the user chooses; setup without the agent path (2026-10-27)
**Context:** operator: setup should let people connect a live Alpaca account, and the "let my AI agent do it" path
should leave the app's setup. Asked when real money may start, the operator chose "whenever they ratify" over
"after the paper graduation gate".
**Decision:** SETTINGS → Trading account (and the wizard's first step) can connect a live account (`ALPACA_LIVE_KEY_ID`
/ `ALPACA_LIVE_SECRET`; test is read-only; half a key pair is refused). Local mode then runs LIVE beside PAPER, and
the cockpit shows the LIVE column once it is connected. LIVE joins at Stop 0 (orders are journaled as SHADOW, nothing
is sent). Turning it on is the constitution's ratification, unchanged: the LIVE dial with RATIFY typed in the app,
confirmed a second time 10 minutes to 24 hours later, both on a sign-in younger than 10 minutes. The Governor's LIVE
gate is now kept by the brain (`liveGate` in status) and the ratify box shows it; a gate that hasn't passed is a red
warning listing the open checks, not a block. Everything else still binds LIVE: cash only (a margin live account is
held until it's made cash-only, the same button as paper), the sizer and caps, breakers (LIVE never self-unlocks from
RED), the kill switch, and the licence check (a licence problem holds entries on live too). The first-launch screen
now leads straight into the wizard; the agent prompt stays available outside the app (docs/SETUP_WITH_AN_AGENT.md,
the `cortex` CLI). The operator's own cloud deployment is unchanged.

## ADR-084 — The landing page: its own look, the real engine on the page, the demo one click away (2026-10-27)
**Context:** operator: build a page whose job is to sell CORTEX-54, premium, scroll-driven (GSAP, smooth scrolling), with
one hard requirement — a demo button — and every claim true to the code. The cockpit's ECAM look (ADR-036) belongs to
the cockpit.
**Decision:** `landing/` is a static, vanilla-TypeScript page built by its own Vite config (`pnpm landing:build` →
`landing-dist/`, the demo cockpit built into `landing-dist/demo/`). Its identity is a public record on paper — warm
paper and ink, Newsreader + IBM Plex (SIL OFL), with two dark chambers — and its story follows one idea through intake,
the hearing, sizing, the constitution, the breakers, graduation and the record. It never restates engine numbers by
hand: the constitution's eight rules and every limit, threshold and cap are printed at build time from
`src/generated/config.ts` (an unknown `%%TOKEN%%` fails the build), the sizing exhibit runs the shipped
`sizePosition()` with the shipped doctrine, and the journal exhibit hashes with the journal's own `rowHash()`. The demo
button opens the real cockpit (ADR-077) in a full-screen dialog from the same origin, with scenario switches (normal,
caution, day one) and DEMO labels on both the dialog and the cockpit. Motion is GSAP 3.15 (standard no-charge
licence) + ScrollTrigger and Lenis (MIT), loaded after first paint and never for reduced-motion users; every scene's end
state equals the static page. Strict CSP as a meta tag (self-hosted everything; `frame-src 'self'` for the demo). The
release workflow now deploys this page to GitHub Pages, so the demo cockpit moved from the site root to `/demo/`. The
page shows no prices (none exist), says LIVE is dormant until graduation, scopes "$0" to free tiers by default, frames
backtests as our own research, and carries a full risk section near the end plus a link to it beside the hero buttons.
**Revision (operator, same day):** the page sells any account size, not $54: $54 is the reference account where every
cent of fees shows, and the page says so once ("Why 54?"). The sizing exhibit gains an account-size switch ($10 to $1B)
and a crypto/stocks switch; the rung comes from `rungForEquity()` and the R1–R5 ladder is printed from the doctrine,
with the top rung's "no ceiling" scoped honestly (at very large sizes market liquidity, not the software, sets the
limit). CORTEX-54 is sold as closed-source software, so the page never links to the source repository or its releases:
every buy button goes to the hosted checkout set in `landing/checkout.ts` (a non-https or GitHub link fails the
build); until that link exists the buttons scroll to the download section, which says checkout opens soon.


## ADR-085 — Savant is the product, Cortex is the agent (2026-10-27)
**Context:** operator: rebrand for sale; the old name mixed the agent, the product and a number ($54) that no longer
describes the product (ADR-081 made every account size first-class).
**Decision:** the app and company are **Savant**; the agent inside it keeps the name **Cortex**; the "54" is retired
($54 stays only as the worked example in the docs and on the page). The reasoning is in `docs/BRAND.md`. Every visible
string, the desktop identifier (`com.savant.desktop`), installers (`Savant_*`), the CLI (`savant`, `cortex` kept as an
alias), the home folder (`~/.savant`, with `~/.cortex54` still read when it exists) and the icon changed. Internal
identifiers that customers never see and that would break deployed state keep their names: Durable Object names, `c54-`
order ids, licence and backup kinds, `CORTEX_*` variables, the keychain service and the repository name.

## ADR-086 — Whop for checkout, licence keys and downloads; a licence server for machine-bound tokens (2026-10-27)
**Context:** operator: sell through Whop (storefront, checkout, licence management) with monthly and yearly plans, a
free demo and a 7-day trial. Whop licence keys can only be checked with a server-side API key, which must never ship
inside the app.
**Decision:** Whop product `prod_sdzK9Kr4E2Kgz` (route `savant-agent`): Monthly $35 and Yearly $299, each with a 7-day
trial (initial price 0, so nothing is charged during it), and a free demo plan. Whop's Software app is attached, so
every membership carries a licence key and the buyer finds key and downloads in their Whop orders. A small Worker,
`savant-license` (`workers/license`), holds the Whop API key and the publisher's Ed25519 signing key: `POST
/v1/activate {key, machine}` checks the membership (active, trialing, completed or past_due; this product; a **paid**
plan only, so a free-demo membership is refused), binds it to a one-way machine fingerprint in the membership's
`metadata.hwid` on first use, and returns a v2 licence token (machine-bound, 14 days, never past the paid period + 1
day). `POST /v1/release` frees the binding from the bound machine; customers can also reset it from Whop. The app
refreshes the token about daily, keeps working offline up to 14 days, and drops it when the server says the
membership ended, the key is unknown, bound elsewhere, for another product or the free plan. Without a valid licence
the demo always works and a broker account keeps its stops but opens nothing new (ADR-077). Rate-limited per address
and per key. `pnpm deploy:license`; secrets `WHOP_API_KEY`, `LICENSE_SIGNING_KEY`. The build bakes the server and store
URLs from the `SAVANT_LICENSE_URL` / `SAVANT_STORE_URL` repository variables.

## ADR-087 — The legal layer: terms, EULA, privacy, refunds, risk; accepted at first launch (2026-10-27)
**Context:** the pre-launch audit (BL-2): a paid product had no licence file, terms, privacy policy or in-app
disclaimer, and third-party attributions were not shipped.
**Decision:** `LICENSE` (proprietary) and `docs/legal/` (terms, EULA, privacy, refunds, risk), rendered to HTML pages
(the app's `/legal/`, getsavant.pro/legal/) and to PDFs for Whop's policy fields. `scripts/third-party.ts` writes
THIRD_PARTY_NOTICES.md (npm production packages, the web panel's runtime packages and fonts, every Rust crate linked
into the shell, Node.js) into every installer and onto the site. At first launch the app shows a short risk summary
and asks the user to accept the terms, EULA and risk disclosure; the accepted version (`src/legal/version.ts`) and
time are stored in config, and new entries on a real broker account are held until the current version is accepted
(bumping the version asks again). The drafts still need a lawyer's review before scale.

## ADR-088 — Pre-launch audit response (2026-10-27)
**Context:** an operator-supplied pre-launch audit (`docs/AUDIT_2026-10-27.md` keeps the ledger) listed blockers and
~70 findings across risk, execution, the LLM path, surfaces, the local app and the research desk. Each finding was
re-verified against the code before acting; some were wrong or already handled and are recorded as such.
**Decision:** every confirmed finding is fixed or answered; the ledger gives each one's verdict and fix. Highlights:
exit management keeps running during broker outages and overnight (GTC whole-share stops, orphan-stop sweep, EXIT
re-pricing); resting entries are cancelled on every reduce-only/pause; calibration maps may only shrink; the fee
hurdle and risk are re-checked at the real order size; journal replays are idempotent and quarantined rows retry daily;
signed requests are bound to their route; `/health` is minimal in public; replay guards on ingest and Discord; per-IP
rate limits; untrusted text is fenced in prompts and rendered inert in cards; the hub's open write surface is bounded;
the sentinel keeps its own kill record; Wi-Fi devices need a fresh sign-in for destructive commands; the desktop's
Node runtime is pinned by version and hash; restores are atomic; research subprocesses get a scrubbed environment;
backtest verdicts need a deflated Sharpe and an un-overfit lab and declare their survivorship bias; README, PRODUCT,
RISK_DOCTRINE and ARCHITECTURE now say what is true (LIVE off until ratified; the 30-day gate is advice, ADR-083).

## ADR-089 — Protection for shipped builds (2026-10-27)
**Context:** operator: protect the program from decompilation and tampering. Software that runs on a customer's
computer can't be made unreadable; the goal is to make reverse engineering expensive and tampering detectable, without
slowing the trading loop.
**Decision:** `scripts/protect.ts`, run by `cortexd:build` (`--no-protect` skips it for quick local builds):
(1) `cortexd.mjs` is minified without source maps and then obfuscated (renamed identifiers, an encoded rotated string
table, numbers as expressions; control-flow flattening and dead-code injection off for speed); (2) the Python research
package ships as bytecode only, compiled for Python 3.12 (the shipped project pins it; uv installs it); (3) the desktop
shell embeds the bundle's sha256 at build time (`build.rs`) and refuses to start, or to run any tray command against, a
modified bundle, showing a reinstall page instead; (4) licences stay Ed25519-signed and machine-bound (ADR-086), so a
patched check is caught by (3) and a forged licence needs the private key, which never ships. Recommended next, an
operator decision: make this repository private and publish installers from a separate public, binary-only releases
repository (only `landing/vercel.json` and the updater fallback would change).

## ADR-090 — getsavant.pro on Vercel; downloads and updates through the product domain (2026-10-27)
**Context:** operator: deploy the landing page to Vercel on getsavant.pro. The GitHub Pages copy exposed the repository
name, and installed apps fetched updates straight from GitHub release URLs.
**Decision:** Vercel project `savant` serves `landing-dist/` (`pnpm deploy:landing`); `landing/vercel.json` carries
security headers (HSTS, nosniff, no-referrer, permissions policy, COOP, frame-options) and redirects:
`/download/<file>` and `/download/v<ver>/<file>` → the release assets, `/updates/latest.json` → the updater manifest,
`/buy` → Whop, `/account` → Whop orders, `www` → apex. Release assets get version-less copies (`Savant_<platform>.<ext>`)
so download links never go stale; the updater reads getsavant.pro first (GitHub as fallback) and `latest.json` links
bundles through getsavant.pro. The page gains pricing (printed from `landing/checkout.ts`), plan checkouts with the
trial, a sign-in link to Whop orders, the legal footer, `/welcome/` (after purchase: downloads and the licence step),
a 404, an Open Graph image and a sitemap. The release workflow no longer deploys GitHub Pages, and goes live only when
every platform and the demo built.

## ADR-091 — Governor proposals are approved in the app on a customer's install (2026-10-27)
**Context:** operator: customers have no GitHub repository, so a Governor "pull request" means nothing to them. On a
customer's computer the weekly Governor tried to write calibration and scar-tissue proposals into the app's own
(read-only, signed) bundle, and nothing would ever apply them.
**Decision:** the app runs the Governor with `GOVERNOR_STATE_DIR` = the Savant home. Proposals go to
`<home>/proposals/` and wait in **Settings → Governor proposals**, where the user approves or dismisses each one. An
approved calibration map is written to `<home>/calibration.json` and replaces the built-in map (re-validated as
shrink-only on every load; a damaged file falls back to the built-in map); an approved rule joins the local scar
tissue. Proposals can only tighten. The publisher's own cloud deployment keeps the pull-request path. Constitution U8
now says this ("self-modification-needs-approval") and that the paper graduation gate is advice before RATIFY
(ADR-083).

## ADR-092 — Releases from a private source repository; customers never need GitHub or git (2026-10-27)
**Context:** operator: the source repository goes private; customers have no GitHub account, only their own
Cloudflare (optional) and API keys.
**Decision:** the release workflow can publish installers to a public, binary-only repository (repository variable
`RELEASES_REPO`, token `RELEASES_TOKEN` with contents write on it); unset, releases stay where they are. Version tags
stay in the source repository. getsavant.pro's download and update redirects take the releases repository at build
time (`SAVANT_RELEASES_REPO`), and the app reads updates only from getsavant.pro. The research desk no longer needs git:
its two pinned open-source packages download as archives with the curl and tar every supported OS ships. Nothing a
customer runs talks to GitHub with an identity; the Governor and research jobs run as local processes.

## ADR-093 — Savant accounts on getsavant.pro (Sign in with Whop) and app sign-in instead of licence keys (2026-10-27)
**Context:** operator: manage accounts, licences, devices and cancellations on our own site, and let people sign in
to the app instead of pasting a key. Clerk was offered; Whop supports OAuth ("Sign in with Whop").
**Decision:** the account **is** the buyer's Whop account (public OAuth app "Savant Account", PKCE, no secret), so
there is one login, no email matching and no second user database. The licence Worker gained the account API
(`workers/license/src/account.ts`): it checks the Whop access token against Whop's userinfo, then acts with the seller
key on that user's memberships only. getsavant.pro/account shows the plan, trial and renewal dates, the computer
holding the licence (name, last check-in), the licence key (for headless installs), **Cancel** (at period end) and
**Keep my subscription**, **Remove this computer**, and **Manage billing** (Whop, for invoices and payment methods).
The app's Settings → Licence leads with **Sign in with your Savant account**: the device-authorization pattern (a
short code, getsavant.pro/activate, approve in the browser, the app picks up its key and activates it through the
normal licence path). One computer at a time: signing in elsewhere asks before moving, and the old computer drops its
licence at its next check. Device codes live 15 minutes in a KV namespace. Vercel proxies `/api/*` to the Worker so
the site's CSP stays `'self'`. getsavant.pro/docs carries the install guide (including the one-time macOS
Gatekeeper and Windows SmartScreen prompts), getting started, account, live trading, troubleshooting and uninstall.
Checkout returns to /welcome/ with a payment confirmation. Also fixed on the way: the licence server read the plan
from `plan_id`, but Whop sends `variant_id`, so every paid key would have been refused as the free plan.

## ADR-094 — Downloads served under the product's name; SETTINGS in groups (2026-10-28)
**Context:** operator: downloads should not come from GitHub, and the printed links were wrong: they asked for
`Savant_darwin-aarch64.dmg` while releases hold `Savant_<version>_darwin-aarch64.dmg` (v0.1.5 even `CORTEX-54_…`), so every
download link returned 404. Vercel Blob was ruled out by its egress limits; R2 needs a card on file (§1); other free
file hosts cap bandwidth or storage.
**Decision:** a small Worker, `savant-downloads` (`workers/downloads`), answers `/download/<target>` (mac, mac-intel,
windows, windows-msi, windows-msix, linux, linux-deb, linux-rpm, linux-arm, linux-arm-deb, linux-arm-rpm) by finding that
file in the latest release, whatever its version, and streaming it as `Savant-<version>-<target>.<ext>` with Range
support. `/download/v<version>/<file>` serves exact files for the updater, `/updates/latest.json` the manifest, `/info`
the version and sizes the site shows. Storage stays the release assets of the public binary repository (free, no
bandwidth cap), which people never see; switching storage changes only `assetUrl`. getsavant.pro redirects
`/download/*` to the Worker (bytes never pass through Vercel, so its bandwidth allowance is untouched) and rewrites the
two small JSON files. The release workflow no longer uploads a second, version-less copy of every installer. Old
`/download/Savant_<platform>.<ext>` links still resolve. getsavant.pro's DNS moved from Vercel to Cloudflare
(2026-10-28; apex A 216.198.79.1 and www CNAME cname.vercel-dns.com, both DNS-only, so Vercel still serves the site) and
the Worker answers on `dl.getsavant.pro`.
The app's SETTINGS page had grown into one 2,700 px column; it is now a list of groups (Licence, Trading, AI models,
Governor, Alerts and phone, Keys and backups, Health) with one group open at a time, each part a card, and a badge
on any group that wants a look (no models, unsigned licence, proposals waiting).

## ADR-095 — The community hub goes live, in the app and on getsavant.pro (2026-10-28)
**Context:** ADR-068 built the hub (signed, hash-linked journal rows, leaderboard, following, memory packs) but it was
never deployed, the app had no screen for it (CLI only) and the site said nothing about it.
**Decision:** the hub runs as the `savant-hub` Worker on `hub.getsavant.pro` with D1 `savant-hub` (`pnpm deploy:hub`
applies the migrations first) and gains `/v1/stats`. The desktop app uses it by default (`DEFAULT_HUB_URL`; HUB_URL still
overrides), but nothing is published until the user joins. SETTINGS → Community: join (creates the agent's key, an
optional leaderboard name), stop sharing / share again, leave (typed LEAVE; deletes the identity, published rows stay),
follow and unfollow agents (checked against the hub), and memory packs: fetch one for review, add it to the robot
(rules only skip trades, beliefs at half confidence), publish one's own. getsavant.pro/community shows the counts, the
leaderboard and the packs; /community/agent/?id= an agent's record and recent public rows; /docs/community/ explains
what a record proves and what is shared. The site reads the hub through a `/hub/*` rewrite (CSP stays 'self'). The
privacy policy now says a user can ask for their agent to be removed (published rows are otherwise permanent).
