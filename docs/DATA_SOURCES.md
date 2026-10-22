# Data Sources (all free)

Every source goes through the `DataRouter` (`src/data/`), which stamps `source`, `fetched_at`,
`as_of`, and enforces staleness limits from doctrine. A source failure triggers its fallback; if the chain
is exhausted the dependent decision is skipped (fail closed).

## Brain (Durable Object pulse)

| Need | Primary | Fallback | Cadence | Notes |
|---|---|---|---|---|
| Account / positions / orders / fills | Alpaca Trading API (paper + live) | — | every pulse | fills via `/v2/account/activities?activity_types=FILL` cursor |
| Equity quotes | Alpaca `/v2/stocks/snapshots` (IEX) | — | every pulse | IEX-only on free plan; widen spread assumptions |
| Crypto quotes / book | Alpaca `/v1beta3/crypto/us/latest/{quotes,orderbooks}` | Coinbase / Kraken public ticker | every pulse | |
| Market clock / calendar | Alpaca `/v2/clock`, `/v2/calendar` | — | clock each pulse (cached 60 s), calendar daily | drives sessions + settlement |
| News | Alpaca `/v1beta1/news` (Benzinga) | SEC EDGAR 8-K Atom feed | every pulse with `since` cursor | **verify free-plan news access in Phase 2**; fallback is filings-only |
| Assets metadata | Alpaca `/v2/assets` | — | daily | fractionable, min order size/increment, tradability |

## Batch (GitHub Actions → `/ingest/batch`)

| Need | Source | Cadence (UTC) | Skill(s) |
|---|---|---|---|
| Daily bars (universe) | Alpaca bars (IEX) | pre-open, post-close | screeners, ATR, breadth |
| Breadth / distribution days / FTD | computed from bars | pre-open | market-breadth-analyzer, ibd-distribution-day-monitor, ftd-detector |
| Crypto regime | CoinGecko Demo (breadth, dominance), OKX/Hyperliquid (funding, OI) | every 4 h | crypto-regime-analyzer (Binance swapped out) |
| Crypto IV | Deribit public (DVOL) | every 4 h | regime context |
| Earnings calendar | Finnhub free or FMP free (key) | daily | earnings-calendar, event-horizon |
| Economic calendar | FRED release calendar | daily | macro-regime, event-horizon |
| VIX / rates | FRED (VIXCLS, DGS10, …) | daily | macro-regime-detector |
| Insider Form 4 | SEC EDGAR full-text / submissions JSON | daily | insider-form4-watcher |
| COT | CFTC Socrata (publicreporting.cftc.gov) | Friday after release | cot-contrarian-detector |
| Polymarket odds | Gamma API | daily (Phase 7+) | macro divergence (read-only) |

## Blocked / avoided

- **Binance, Bybit**: geo-block US IPs (GitHub runners are US; Cloudflare egress varies). Never a primary.
- **FINVIZ scraping**: ToS risk; use our own screeners on Alpaca bars instead.
- **yfinance**: unofficial; allowed only in research notebooks, never in the decision path.
- Paid feeds (SIP, OPRA, Polygon paid, CoinGlass): out of scope by the $0 rule.

## Hygiene rules

- EDGAR requests carry `User-Agent: CORTEX-54 research <operator email>` and stay < 10 req/s.
- Every external text blob (headline, filing excerpt, LLM output) is treated as untrusted data: length
  capped, control chars stripped, wrapped in a `data` field, never concatenated into instructions.
- No historical replay may read data with `as_of > T_sim` (temporal fence; enforced in `research/`).
