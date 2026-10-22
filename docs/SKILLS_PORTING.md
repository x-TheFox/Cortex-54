# Skills Porting Plan

The spec wanted 85–91 skills ported to TypeScript/WASM. We don't do that. Each skill gets exactly one
**runtime**, chosen by where it's needed and what it costs:

| Runtime | Meaning | When |
|---|---|---|
| `ts-hot` | Pure TypeScript in the Worker bundle | needed inside a pulse or the court; small; deterministic |
| `py-batch` | Python in `research/`, run by GitHub Actions, output POSTed to `/ingest/batch` | screeners, regime scores, anything that loops over a universe or needs pandas |
| `llm-prompt` | A versioned prompt in `src/court/prompts/` | qualitative judgment (the bull/bear briefs) |
| `deferred` | Not before the phase listed | |
| `cut` | Not in scope | |

The registry of record is `config/skills-index.yaml`. This doc explains the rules.

## Rules

1. **Python first, port only the hot path.** Both seed repos are maintained Python (pushed this week). For
   `py-batch` skills we vendor or pip-install upstream code and wrap it; we don't fork the logic.
2. **Parity tests for every `ts-hot` port.** Generate fixtures by running the upstream Python on recorded
   inputs (`research/fixtures/generate.py`) and assert the TS output matches within tolerance
   (`test/fixtures/<skill>.json`).
3. **JSON in, JSON out.** Every skill output carries `skill_id`, `version`, `as_of`, `inputs_hash`,
   `confidence` and `provenance[]`. Human ceremony (prompts, confirmations, markdown) is stripped.
4. **Broker rewiring.** staskh `ib-*` skills are IBKR-specific. Only their math (Greeks, spreads, PMCC
   rubric, 0DTE gating logic) is ported; the I/O is re-pointed at Alpaca.
5. **Data source swaps** are explicit in the registry (`data_swaps:`), e.g. Binance funding → OKX/Hyperliquid.
6. **Attribution.** Ported MIT code keeps its copyright header and is listed in `NOTICE.md`.
7. **Lifecycle.** `PROPOSAL → SHADOW → ACTIVE → DEMOTED`. A skill influences sizing only when ACTIVE.
   SHADOW skills run and get scored (reputation) but carry `W_rep = 0` in the sizer.
   Promotion requires a Governor PR with BH-FDR-adjusted evidence.

## `ts-hot` set (Phase 1–3)

| Skill | Source | Why hot |
|---|---|---|
| position-sizer | tradermonty | every order |
| pre-trade-validator (pre-trade-discipline-gate + rails) | tradermonty | every order |
| drawdown-circuit-breaker | tradermonty | every pulse |
| portfolio-heat / correlation-guard | new (tradermonty portfolio-manager ideas) | every order |
| fee-and-slippage-auditor | new | every fill |
| technical-indicators (ATR, EMA, RSI, VWAP dist, vol z-score, Yang-Zhang RV) | staskh technicals | Tier 0 state |
| exposure-coach (combine step only) | tradermonty | regime gate; inputs come from batch |
| smart-order-router (limit pegging) | new (hummingbot executor pattern) | execution |
| black-scholes-greeks + IV solver | staskh black_scholes/greeks | shadow lab pricing, implied move |
| spread-structurer + PMCC rubric | staskh spreads/scanner_pmcc | shadow lab |

## `py-batch` set (Phase 2+)

market-breadth-analyzer, uptrend-analyzer, ibd-distribution-day-monitor, ftd-detector, market-top-detector,
macro-regime-detector, crypto-regime-analyzer (data swap), vcp-screener, canslim-screener (data-limited),
stockbee-momentum-burst-screener, stockbee-exhaustion-hammer-screener, pead-screener,
earnings-calendar, economic-calendar, cot-contrarian-detector, news-reaction-failure-analyzer,
insider-trading (Form 4), piotroski f-score, signal-postmortem (weekly), trade-performance-coach (weekly),
backtest-expert / Monte Carlo (Governor), plus our Governor modules: brier/reliability, isotonic
calibration, BH-FDR, rejection-ledger grading, drift detector.

## Cut (and why)

- `kanchi-dividend-*`, `value-dividend-screener`, `dividend-growth-pullback-screener`: long-horizon income
  strategies irrelevant at $54 (TaxGuard idea revisits wash-sale logic at R3+).
- `mt5-robot-tester`, `futures-position-sizer`, `fxmacrodata-calendar`: wrong venue.
- `parabolic-short-trade-planner`, `pair-trade-screener` (short leg): no shorting (constitution).
- `ib-account`, `ib-portfolio*`, `ib-trades-history`, `ib-create-consolidated-report`, `markdown-to-pdf`:
  IBKR / human reporting plumbing.
- `skill-designer`, `skill-idea-miner`, `skill-integration-tester`, `dual-axis-skill-reviewer`,
  `trading-skills-navigator`, `stockbee-setup-fluency-trainer`: human-workflow tooling.
- HKUDS NET family (ai4trade bridge, copytrade, tradesync, heartbeat, market-intel, polymarket arb):
  no license, external dependency, and publishing our theses has negative value.
