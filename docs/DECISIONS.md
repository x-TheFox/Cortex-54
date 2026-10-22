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

