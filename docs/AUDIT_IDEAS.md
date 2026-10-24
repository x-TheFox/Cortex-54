# Audit idea triage — every idea in the external ledger (2026-10-24)

The operator's audit ledger proposed 121 ideas in three waves (W1 runtime/ops, W2 cognition/learning, W3 risk/execution/
operator/paradigms; the ~100 research-dossier seeds are folded into them). Each one gets a verdict, decided against the
code as it stands and the constraints that matter here: a $54 account where the $10 crypto minimum dominates sizing,
free tiers only, LIVE dormant, one operator.

**Done** = already in the code (ADR-046…051). **Build** = implemented in the ADR-053…055 round.
**Later** = worth it, but blocked on data or on LIVE; the trigger says when. **No** = not worth it here, and why.

## Wave 1 — runtime, persistence, operations

| # | Idea | Verdict | Why / where |
|---|---|---|---|
| W1-01 | Outbox dead-letter + bisection | Done | ADR-048 #3 |
| W1-02 | Hot-state compactor | Done | ADR-048 #4 (+ dossiers, ADR-051) |
| W1-03 | Boot-time chain re-anchor | Build | ADR-053: on boot, a GENESIS head adopts D1's head; a mismatch blocks appends and alarms |
| W1-04 | Journal tail ring, per-pulse verify | No | +1 DO row write per journal row for a check the Governor runs daily; ADR-048 (d) |
| W1-05 | D1 retention via Governor | Later | D1 is < 1% of 500 MB; trigger: any table > 100 MB or export pages > 50 |
| W1-06 | Single-flight flush | Build | ADR-053: flush guard (concurrent callers return 0) |
| W1-07 | Dispatch receipt reconciliation | Build | ADR-053: expected batch not seen → `DISPATCH_STALE` alert |
| W1-08 | Deploy-lag watchdog | Build | ADR-053: Governor journals the git doctrine SHA; mismatch > 24 h alerts |
| W1-09 | Per-account kill payload | Build | ADR-053: JSON kill payload with accounts + kill id; old string flag still read as global |
| W1-10 | Sentinel flatten retry | Done | ADR-048 #8 |
| W1-11 | External dead-man pings | Later | needs an operator-created Healthchecks.io account (Claude can't create accounts); RUNBOOK step |
| W1-12 | Provenance-tainted contract fields | Done (by construction) | checked in ADR-054: the entry price is always the live bid (code), stops/targets an LLM proposes are repaired or rejected by `checkBull` against the evidence, and contracts have no size field. The new injection suite (W3-30) pins all three; a type-level taint layer would add nothing on top |
| W1-13 | Pulse stage trace | Build | ADR-053: per-stage daily failure counts in `/health` + one structured log line per pulse |
| W1-14 | Heartbeat v2 / alarm probe | Build | ADR-053: sentinel also checks `next_alarm_at` (the start-of-pulse claim was false, ADR-048 (a)) |
| W1-15 | Alarm-loss telemetry + backoff | Build | backoff Done (ADR-048 #9); ADR-053 adds `ALARM_LOST` journaling |
| W1-16 | Predictive burn-rate budget | Build | ADR-053: projected end-of-day use drives THRIFT; limit-hit amnesty at day roll |
| W1-17 | Budget-counter coverage | Build | ADR-053: court LLM hops go through the subrequest guard and per-provider counters (with W2-06) |
| W1-18 | Meter scope stack | Build | ADR-053 |
| W1-19 | Dispatch cron-matcher correctness | Build | ADR-053: per-field bounds + property test vs brute force |
| W1-20 | Candidate lease ledger | Done/Build | rejection row on a throw Done (ADR-048 #10); items are truncated so none is oversized; ADR-053 retires an item Clef fails on 3 times |
| W1-21 | Fill apply-then-seen | Done | ADR-048 #2 |
| W1-22 | KILL_SEEN convergence | Build | ADR-053, with W1-09's kill id |
| W1-23 | Workers Logs | Build | ADR-053: `observability.enabled` + one structured line per pulse (free) |
| W1-24 | Persistent alert ledger | Done | already persistent (settings rows, journaled ALERT); ADR-053 adds per-stage daily failure counts |
| W1-25 | Per-capability HMAC + nonce | Build | ADR-053: single-use nonce on `/admin/reset`; secret split Later (rotation across GitHub + 2 workers; trigger: before RATIFY) |
| W1-26 | Step-up auth + session epoch | Build | LIVE controls are Discord-only already (ADR-048 #11); ADR-053 adds server-side logout via a session epoch |
| W1-27 | Per-origin rate limiting | No | login tokens are single-use 256-bit; commands need a valid session; Cloudflare already absorbs floods |
| W1-28 | Policy SHA stamp on contracts | Build | ADR-054: every COURT journal row carries the running doctrine and constitution hashes (no D1 migration needed) |
| W1-29 | Strategy capability manifests | Later | param schemas Done (ADR-050); trigger: a strategy that trades outside one arena |
| W1-30 | Env-binding drift CI | Build | ADR-053: `scripts/check-env.ts` in CI |
| W1-31 | CSP report + verify.ts pin | Build | font-src Done (ADR-048 #1); ADR-053 adds the vendored-copy diff check in CI |
| W1-32 | Agent SLO card | Build | ADR-053: `/health.slo` + the daily status card |
| W1-33 | OTel-shaped llm_calls | No | no consumer; re-shaping later is a query, not a migration |
| W1-34 | Journal replay verifier | Later | needs W1-28 stamps plus a month of contracts; trigger: 2026-11-30 |
| W1-35 | Property tests | Done | ADR-050 (+ P5–P6 in ADR-054) |
| W1-36 | Doc claim-lint CI | Build | ADR-053: `test/docs.test.ts` claims table |
| W1-37 | vitest-pool-workers DO tests | Later | heavy dev-dep; trigger: the next DO-shell bug |
| W1-38 | Cost per decision on contracts | Build | ADR-054 (same as W2-39) |
| W1-39 | Normative monitor in /health | Build | ADR-053: ≤ 6 SQL invariants, sentinel alerts on any violation |
| W1-40 | Hot-state snapshot lane | Later | trigger: first DO storage reset, or before RATIFY |

## Wave 2 — cognition, memory, learning, research

| # | Idea | Verdict | Why / where |
|---|---|---|---|
| W2-01 | Panel vs self-consistency grader | Build | data logged (ADR-049 #5); ADR-055 adds the Governor comparison and a `panel_mode` switch |
| W2-02 | Position-bias-hardened panel | Build | ADR-054: seat order shuffled per hearing (seeded); no duplicate swap calls |
| W2-03 | Evidence-citation lint | Build | ADR-054: numbers in arguments that appear nowhere in the evidence are flagged and counted |
| W2-04 | Clairic out-of-band verification | Done | grounding check (ADR-048 #12) + the research desk cross-checks catalysts (ADR-051) |
| W2-05 | Hearing deadline + degradation | Build | ADR-054: 150 s hearing budget; panel dropped first (`HEARING_DEGRADED`) |
| W2-06 | Provider quota ledger | Build | ADR-054: per-provider daily call counters; exhausted provider skipped |
| W2-07 | Disagreement tax | Build | ADR-054: computed and journaled, multiplier 1.0 (off) until the Governor grades it |
| W2-08 | Tier 1 paraphrase invariance | No | doubles Tier 1 neurons for a noise filter whose misses Tier 2 and the court catch |
| W2-09 | Schema-tightness unification | Build | ADR-054: Clef scores clamped, choices validated against the option set |
| W2-10 | Funnel quarantine | Done | ADR-048 #10 |
| W2-11 | Belief dedupe (Mem0-style) | Build | ADR-055: token-Jaccard merge in `memory.py` |
| W2-12 | Provenance-anchored beliefs | No | beliefs only arrive through HMAC-signed Governor batches; the anchor adds no new attacker cost |
| W2-13 | Dawid-Skene reputation | Later | needs ≥ 200 graded outcomes per source |
| W2-14 | Scar-veto counterfactuals | Build | ADR-055: SCAR rejections are already graded; Governor reports veto cost per scar |
| W2-15 | CBR playbooks | Later | needs ≥ 3 clustered postmortems; zero exist |
| W2-16 | Governor CI integrity | Done | ADR-049 #1–2 |
| W2-17 | Per-kind belief half-lives | Build | ADR-055 |
| W2-18 | Reflection pass → beliefs | Later | needs postmortem volume and W2-11; trigger: ≥ 30 closed trades |
| W2-19 | Platt → isotonic ladder | Done | ADR-049 #3 |
| W2-20 | Conformal abstention | Later | needs ≥ 100 calibration pairs |
| W2-21 | Brier decomposition | Build | ADR-055: report card shows reliability / resolution / uncertainty |
| W2-22 | One barrier function + ambiguity flag | Build | ADR-055: shared first-touch, both-touch bars flagged ambiguous and excluded from fitting |
| W2-23 | Calibration label change | No | the court's question is target-before-stop; ADR-048 (b) |
| W2-24 | Purge + embargo | Build | ADR-055: overlapping holds de-duplicated before fitting/bootstrapping |
| W2-25 | Map acceptance check | Build | ADR-055: a proposed map must beat the incumbent's out-of-fold Brier |
| W2-26 | Per-role calibration | Later | many small maps need labels; trigger: ≥ 200 graded Tier 2 rejections |
| W2-27 | Backtest lab (+ CPCV/PBO) | Done/Build | lab Done (ADR-046); ADR-055 adds PBO via CSCV |
| W2-28 | Deflated Sharpe gate | Build | ADR-055 |
| W2-29 | HMM-lite regime | Build | ADR-055: 2-state HMM as a LOW-confidence regime feature in evidence; no sizing effect until graded |
| W2-30 | Funding-rate crowding | Build | ADR-055: extreme funding shrinks risk (×0.5, shrink-only) and shows in evidence |
| W2-31 | Kronos challenger + pinning | Done/Later | revision pin Done (ADR-049 #4); challenger after the LAB has graded Kronos alone (2026-11-24) |
| W2-32 | Kronos grading + cadence | Done/Later | cadence Done (ADR-048 #13); grading = the LAB forward test |
| W2-33 | Meta-labeling | Later | needs ≥ 100 labelled contracts; ADR-054 logs the features with every COURT ruling |
| W2-34 | Options realism pack | Build | ADR-055: per-contract fees, options tick, short-leg DTE < 7 blackout (lab only) |
| W2-35 | Locked-window replay | Later | trigger: one month of journaled court decisions (2026-11-24) |
| W2-36 | Realized slippage feedback | Build | ADR-054: fill vs order price journaled (`slip_bps`); Governor reports drift (ADR-055) |
| W2-37 | Trend strategy + completed bars | Done | ADR-045/046/050 (backtest says LOSES → LAB only) |
| W2-38 | Injection canaries | No | one item per Clef call and per court hearing: a canary can never share a context with real items, so it can't detect cross-contamination |
| W2-39 | Cost per decision | Build | ADR-054 |
| W2-40 | Freshness classes | Build | ADR-054: every evidence block carries FRESH/STALE/OLD; OLD quotes fail closed |
| W2-41 | Bear persona rotation | Build | ADR-054: 3 bear mandates rotated by hearing |

## Wave 3 — risk, execution, operator surface, security, paradigms

| # | Idea | Verdict | Why / where |
|---|---|---|---|
| W3-01 | Hysteretic breaker | Build | corrupt-equity half Done (ADR-048 #6); ADR-054 adds recovery-pulse hysteresis |
| W3-02 | Policy-vacuum registry | Build | ADR-054: each fail-open branch counted; unknown-arena slippage fails closed |
| W3-03 | Cluster-aware correlation | Later | ≤ 3 positions at R1; trigger: R3 (≥ 5 positions) |
| W3-04 | Vol-targeted risk | No | at $54 the $10 venue minimum sets most order sizes; shrinking risk just turns trades into rejections. Revisit at R2 |
| W3-05 | Participation caps / venue minimum per asset | No | $10 tickets on BTC/ETH/SOL are < 0.0001% of volume |
| W3-06 | p90 spread in stops | Build | ADR-054: rolling spread high-water per symbol feeds the stop distance |
| W3-07 | Honest options friction | Build | with W2-34 |
| W3-08 | Scar coalescer + market facts | Build | ADR-055: schema-valid scar drafts; funding and regime join FACT_FIELDS |
| W3-09 | Price collars + bad-print flags | Done/Build | collar Done (entries always price at the bid inside the zone; the daily order cap throttles storms); ADR-054 adds BAD_PRINT for fills > 75 bps through the order price |
| W3-10 | Twin divergence → breaker | Later | LIVE dormant; trigger: RATIFY |
| W3-11 | 429-aware broker client | Build | ADR-054 |
| W3-12 | Passive-entry ladder | Later | needs fill data first (W2-36); trigger: ≥ 30 entries with unfilled-rate known |
| W3-13 | Slippage loop + twin ledger | Build | ADR-054: every FILL journals realized slippage vs the order price; Governor report in ADR-055; no auto-override until 30 fills |
| W3-14 | Square-root impact | No | same as W3-05 |
| W3-15 | Orphan adoption attribution | Build | ADR-054: re-match by symbol/side/qty before falling back to zero risk |
| W3-16 | Cash-settlement ledger | Done | `unsettled` table (Phase 1) |
| W3-17 | IEX data-quality score | Done/Build | crossed or empty quotes were already refused; ADR-054 stops the court before any LLM call on a stale quote and labels input freshness |
| W3-18 | Deflation-gated replay lab | Done/Build | lab Done; DSR/PBO in ADR-055 |
| W3-19 | HMM + funding | Build | = W2-29/W2-30 |
| W3-20 | One label space | Build | = W2-22/W2-24 |
| W3-21 | Server-side destructive confirmation | Done/Build | web Done (ADR-048 #11); ADR-053 adds `min_length` on Discord `/unlock` |
| W3-22 | Revocable scoped sessions | Build | = W1-26 |
| W3-23 | Telemetry-plane watchdog | Done | ADR-048 #7 (+ SLO card W1-32) |
| W3-24 | RATIFY cooling-off | Build | ADR-053: RATIFY needs a second confirmation ≥ 10 min after the first |
| W3-25 | Operator trust telemetry | No | one operator; alert counts (W1-24) cover the useful part |
| W3-26 | Structured postmortem + kill epochs | Build | ADR-053: KILL_SEEN journals scope, reason and the sentinel's kill id (unlock postmortems stay free text ≥ 50 chars) |
| W3-27 | Cockpit transport v2 | Build | ADR-053: AbortController + stale-response guard (delta sync not worth it at 15 s polls) |
| W3-28 | Secret split + nonce | Build/Later | = W1-25 |
| W3-29 | CSP closure + render parity CI | Done/Later | font-src Done; render CI after the next UI bug |
| W3-30 | Injection regression suite | Build | ADR-054: golden corpus against every LLM-output interpreter |
| W3-31 | ADR linter | Build | with W1-36 |
| W3-32 | Governor CI closure | Done | ADR-049 #1 (validation runs before the PR exists) |
| W3-33 | Constitution as theorems | Build | ADR-054: properties P5 (RED ⇒ no entries) and P6 (exits never gated) |
| W3-34 | Capability taint | Done (by construction) | = W1-12 |
| W3-35 | Shadow fleet | Done (partly) | the LAB brain (ADR-045) is a one-overlay fleet; more overlays after it proves itself |
| W3-36 | Federated scar tissue | No | single instance |
| W3-37 | RTS 6 controls | No | W3-09 supplies the mechanics; the regulatory vocabulary adds nothing for a $54 cash account |
| W3-38 | Temporal-logic monitors | Build | = W1-39 |
| W3-39 | Publishable microstructure dataset | Later | after 30 days of fills; operator decision (public repo) |
| W3-40 | Signed-intent execution | No | single venue; `client_order_id` already makes submits idempotent |

**Tally (121 ideas):** Build 63 · Done 14 (+2 by construction) · Later 17 · No 14 · split verdicts 11 (Done/Build 6, Done/Later 3, Build/Later 1, Done partly 1).
