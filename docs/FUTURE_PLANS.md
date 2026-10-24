# Future plans

Everything worth doing later, in one place. Each item names what should bring it back; until then it stays out of
the code. What was already built is recorded in `docs/DECISIONS.md` (ADR-046 … ADR-055). IDs like W2-13 refer to the
external audit ledger (2026-10-24).

## Needs data first (revisit when the trigger is met)

| Idea | Trigger | Why wait |
|---|---|---|
| Calibration per role (Tier 2, panel seats) — W2-26 | ≥ 200 graded Tier 2 rejections | many small maps need labels |
| Conformal abstention band on court win prob — W2-20 | ≥ 100 calibration pairs | needs held-out pairs |
| Dawid-Skene source reputation — W2-13 | ≥ 200 graded outcomes per source | label-hungry |
| Reflection pass → beliefs, case-based playbooks — W2-18, W2-15 | ≥ 30 closed trades, ≥ 3 clustered postmortems | nothing to reflect on yet |
| Meta-label size model — W2-33 | ≥ 100 labelled contracts (features already logged with every COURT ruling) | |
| Turn the panel off if it adds nothing — W2-01 switch | panel-vs-judge line on the weekly report shows no edge over ≥ 50 trades | grader is live, switch isn't |
| Disagreement tax on contested rulings — W2-07 | Governor shows contested rulings do worse | flag is logged, tax is 1.0 |
| Kronos challenger model (Chronos/TimesFM) — W2-31 | after the LAB has graded Kronos alone (≈ 2026-11-24) | |
| Locked-window replay of the court vs buy-and-hold — W2-35 | one month of journaled court decisions (≈ 2026-11-24) | |
| Journal replay verifier (sizing/validator reproduce) — W1-34 | 2026-11-30 | needs a month of stamped contracts |
| Passive-entry repricing ladder — W3-12 | ≥ 30 entries with a known unfilled rate | slippage data is now journaled |
| Slippage-driven fee model override — W3-13 | ≥ 30 fills with `slip_bps` | measurement is live |
| Volatility-regime model as a size input — W2-29 | Governor grades the HMM gate's counterfactual cost | court context only today |
| Publishable microstructure dataset — W3-39 | 30 days of fills, and operator's say-so (public repo) | |

## Needs LIVE (only matters once real money is ratified)

| Idea | Note |
|---|---|
| Paper↔live twin divergence as a breaker input — W3-10 | LIVE is dormant |
| Hot-state snapshot / disaster restore — W1-40 | before RATIFY, or after the first DO storage reset |
| Per-capability HMAC secrets + rotation — W1-25 / W3-28 | before RATIFY; replay guard on `/admin/reset` is already live |
| Cluster-aware correlation guard — W3-03 | at rung R3 (≥ 5 positions) |
| Volatility-targeted per-trade risk — W3-04 | at R2: at $54 the $10 minimum sets most sizes |

## Needs the operator

| Idea | What's needed |
|---|---|
| External dead-man pings for brain and sentinel — W1-11 | a free Healthchecks.io account (Claude can't create accounts) |
| CI deploys on merge | a Cloudflare API token as GitHub secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (RUNBOOK) |
| D1 retention pipeline — W1-05 | only when a table passes ~100 MB |
| Persist "ambiguous" first-touch grades — W2-22 | a D1 migration (operator applies migrations); both graders already count same-bar touches as STOP |

## Small, not urgent

- Scar coalescer: schema-checked scar drafts and market facts (funding, regime) as scar fields — W3-08.
- Options lab realism: per-contract fees, options tick size, short-leg DTE < 7 blackout, assignment stub — W2-34 / W3-07.
- Workers-runtime tests for the DO shell (vitest-pool-workers) — W1-37, after the next DO-shell bug.
- Strategy capability manifests — W1-29, if a strategy ever spans arenas.
- Production-render CI for the web terminal — W3-29, after the next UI bug.

## Decided against (and why)

- Journal tail ring checked every pulse (W1-04): one extra DO write per journal row; the Governor verifies daily.
- Tier 1 paraphrase re-asks (W2-08): doubles Tier 1 neurons for a noise filter.
- Injection canaries (W2-38): one item per Clef call and per hearing, so a canary can't share context with real items.
- Belief chain anchors (W2-12), OTel-shaped LLM logs (W1-33), per-IP rate limits (W1-27), operator-trust telemetry
  (W3-25), federated scars (W3-36), RTS 6 vocabulary (W3-37), signed-intent orders (W3-40): no benefit for one
  operator, one venue and a $54 account.
- Participation caps and square-root impact (W3-05, W3-14): $10 tickets are a vanishing share of volume.
- Relabelling calibration pairs (W2-23): the court's question is target-before-stop, which the labels already match.
