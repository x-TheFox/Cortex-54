# Risk Doctrine — the $54 math

All numbers here are defaults from `config/doctrine.yaml`, bounded by `config/constitution.json`.
Doctrine may only be **tighter** than the constitution.

## 1. Position sizing (`src/risk/PositionSizer.ts`, pure)

Inputs: equity `E`, rung per-trade risk `r_trade`, conviction `c ∈ {1..10}`, calibrated win probability
`p̂`, bear disagreement `D_bear ∈ [0, 0.7]`, reputation weight `W_rep ∈ [0.5, 1.2]`, breaker multiplier
`M_breaker ∈ {1.0, 0.5, 0}`, entry `P_e`, stop `P_s`, round-trip fee rate `f_rt`, spread `s`.

```
r_eff   = r_trade · (c/10) · (1 − D_bear) · W_rep · M_breaker · g(p̂)
g(p̂)    = clamp((p̂ − 0.5) / 0.25, 0, 1)          # no edge → no size; p̂ ≥ 0.75 → full
d_stop  = |P_e − P_s| / P_e + f_rt + s/(2·P_e)
N       = min( E·r_eff / d_stop,  E·C_max_conc,  settled_cash,  heat_room / d_stop )
qty     = floor_to_increment(N / P_e)              # round DOWN to asset min increment
reject if N < max(asset_min_notional, $1.00) or qty < asset_min_qty
```

Constraints: `|P_e − P_s| ≥ 1.2 · ATR14` (no noise stops); `W_rep = 1.0` until a source has ≥20 resolved
signals; `D_bear = min(0.7, max(0, bear_lethality − 0.3))` by default.

`p̂` source: COURT contracts use calibrated Clef probability, shrunk toward 0.5 with weight
`max(warmup_min_weight, n/50)` until 50 outcomes exist (so the system can still trade small and learn);
RULE contracts use the strategy's `prior_win_prob` from doctrine.

### Worked example (R1, E = $54, crypto)
`r_trade = 2.5%`, `c = 7`, `D_bear = 0.1`, `W_rep = 1`, `M = 1`, `p̂ = 0.66 → g = 0.64`
→ `r_eff = 0.025·0.7·0.9·0.64 = 1.008%` → risk budget $0.544.
Stop 4% + fees 0.40% (maker entry 0.15% + taker exit 0.25%) + half-spread 0.05% → `d_stop = 4.45%` →
`N = $12.23` (< $18.90 cap) → OK. Max loss if stopped ≈ $0.54. Fee cost ≈ $0.05.

## 2. Fee hurdle (Tier 0)

```
expected_move ≥ hurdle_mult · (f_rt + s/P_e)       hurdle_mult = 3.0
crypto f_rt = maker entry + taker exit ≈ 0.40%   (all-taker 0.50%; Alpaca tier < $100k / 30 d)
equities f_rt ≈ 0 + regulatory sell fee (≥ $0.01 rounding → ~5 bps on an $18 sell)
paper ledgers apply the same fees + slippage_bps (default 5 bps equities, 10 bps crypto)
```
`expected_move` comes from the bull brief's target **checked in code** against ATR: a target further than
`3 · ATR14 · sqrt(horizon_days)` is clipped.

## 3. Heat and concentration

| Rung | Equity band | Total heat | Per-trade risk | Max position notional | Max positions |
|---|---|---|---|---|---|
| R1 Ignition | $54–$100 | 12% | 2.5% | 35% | 3 |
| R2 Proof | $100–$250 | 15% | 2.5% | 35% | 3 |
| R3 Velocity | $250–$2,500 | 18% | 2.0% | 30% | 4 |
| R4 Scale | $2,500–$25,000 | 20% | 1.5% | 25% | 6 |
| R5 Fund | $25,000+ | 20% | 1.0% | 20% | 10 |

Correlation guard: two positions with 60-day return correlation > 0.7 (or same sector ETF / same crypto
beta bucket) share one slot's risk.

## 4. Circuit-breaker ladder (per account, drawdown from high-water mark)

| Band | Condition | Effect |
|---|---|---|
| GREEN | DD < 3% | `M_breaker = 1.0` |
| YELLOW | 3% ≤ DD < 6% | `M_breaker = 0.5`, Tier 3 quota halved |
| ORANGE | 6% ≤ DD < 10% | `M_breaker = 0` → REDUCE_ONLY; existing stops tightened to breakeven where possible |
| RED | DD ≥ 10% **or** daily loss ≥ 5% **or** 3 consecutive stop-outs in 24 h | flatten all, lock loop; unlock = operator postmortem modal |

Constitution caps: Red at no worse than 12% DD and 6% daily loss.

## 5. Settlement (equities, cash account)

Each buy lot records `funded_by` (settled cash vs unsettled proceeds). A lot funded by unsettled proceeds
may not be sold before those proceeds settle (T+1, business days from Alpaca calendar) → otherwise a
good-faith violation. The sizer uses `settled_cash_available` for equities. Crypto proceeds are tracked
separately (verify Alpaca's crypto settlement behavior in Phase 1 and record it here).

## 6. Autonomy dial (per account)

| Stop | Name | Behavior |
|---|---|---|
| 0 | Shadow / dormant | contracts generated + journaled (`SHADOW`), nothing executes |
| 2 | Paper Auto | PAPER executes on its own within rails (valid for PAPER only) |
| 3 | Live Auto | LIVE executes on its own within rails (valid for LIVE only; needs `RATIFY`) |
| 4 | Colleague | as 2/3, plus the Governor may auto-apply *doctrine* PRs that only tighten limits |

**There is no approve-each-trade mode** (operator decision 2026-10-22, ADR-024). Stop 1 does not exist; the
`/dial` command rejects it and boot migrates any stored Stop 1. `#bull-vs-bear-court` shows contracts for
information only. Valid stops: PAPER {0, 2, 4}, LIVE {0, 3, 4}.

Initial: PAPER = Stop 2 (fully autonomous). LIVE = Stop 0 (dormant) until §7's LIVE gate is met.

## 7. Capital ladder graduation (two consecutive weekly reviews, measured with modeled fees)

| From → To | Gate |
|---|---|
| LIVE Stop 0 → Stop 3 (real money switches on) | **(a) Total implementation:** ROADMAP Phases 0–6 complete and merged (full funnel, learning loop, cockpit). **(b) Fully autonomous PAPER run:** ≥30 consecutive days with no operator intervention in trading (no /pause, /flatten, /unlock, kill), ≥25 closed trades, positive post-fee expectancy, profit factor > 1.2, zero rail violations, heartbeat ≥99.9%, calibrated Brier < 0.25, every RED trip self-recovered and reviewed. **(c)** Live kill drill passed. **(d)** Operator ratifies with `/dial account:LIVE stop:3 confirm:RATIFY` |
| R1 → R2 | equity ≥ $100 (or operator deposit) + above |
| R2 → R3 | ≥1 YELLOW recovered cleanly, Sharpe (daily, 60 d) > 1.0, ≥2 strategies with positive expectancy |
| R3 → R4 | Monte Carlo 5th-pct drawdown within RED band; p < 0.05 vs random entry timing (BH-FDR adjusted); cognitive cost $0 maintained |
| Options live | sizer permits the smallest defined-risk spread (max loss ≤ per-trade risk) **and** shadow lab ≥30 options trades with positive post-fee expectancy |

Demotion is automatic: the rung is always capped by current equity. A LIVE RED trip flattens and locks; unlocking
LIVE (operator postmortem) resets its dial to Stop 0, so real money needs a fresh RATIFY. PAPER recovers from RED
by itself after `breakers.paper_auto_unlock_hours` (≥ constitution minimum 12 h) once flat, with a machine
postmortem (ADR-025).

## 8. Things the risk engine always does

- Counts positions + open orders + reservations for every heat check.
- Refuses entries when any input is stale (`doctrine.staleness`).
- Refuses entries within 72 h of the symbol's earnings unless the strategy is an earnings strategy.
- Refuses entries in the last 10 min of a session for equities (no overnight gap surprise by accident).
- Logs every rejection with reason codes to D1 `rejections` (the shadow ledger grades them later).
