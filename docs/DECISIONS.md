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
