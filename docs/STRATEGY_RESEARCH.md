# Strategy research: what successful traders do, and what survives a $54 cash account

Operator request (2026-10-24): research how successful traders trade, extract the strategies that actually win, and
rebuild them in CORTEX-54. This file is the research pass and the build queue. It is opinionated on purpose.

## The rule we apply before copying anyone

Published "winning strategies" are mostly survivorship and backtest overfitting: the traders and papers we hear about
are the ones whose numbers looked good. So a strategy enters CORTEX-54 only if:

1. there is **independent evidence net of costs** (peer-reviewed, or a replication that charges fees and slippage);
2. it fits our constraints: cash only, long only (bearish exposure via 1x inverse ETFs, ADR-040), crypto spot at
   0.15–0.25% per side with a **$10 minimum order** (ADR-042), fractional US equities at $0 commission, T+1 settlement,
   at most 3 positions at $54;
3. it passes **our own** backtest with our fee model and a multiple-testing correction (BH-FDR, as the Governor
   already does) before it can size real paper risk.

Celebrity systems with no credible published test (Minervini VCP, Qullamaggie episodic pivots, most YouTube setups)
are not encoded as rules. They already reach the court as setup candidates through the Stockbee/VCP screeners
(the doctrine entries `CRYPTO_VCP_BREAKOUT_V1`, `EQUITY_MOMENTUM_BURST_V1` and `EQUITY_EARNINGS_DRIFT_V1` have no
parameters and no runner: they only label where a screener candidate came from)
(ADR-035), where a human-style pattern is judged with the rest of the evidence.

## Findings

| # | Strategy family | Evidence net of costs | Fits $54 cash? | Verdict |
|---|---|---|---|---|
| 1 | **Crypto time-series momentum / trend** (hold coins in an up-trend, exit on trend break) | Strongest of the crypto anomalies: time-series momentum survives realistic costs while cross-sectional momentum mostly does not (Han, Kang & Ryu). Rotational top-coin trend reported Sharpe > 1.5 net of fees (Barbon & Beneder) | Yes: daily, low turnover, 1–3 coins | **Build first** — upgrade the breakout baseline into a proper multi-lookback trend strategy with a trailing exit |
| 2 | Crypto cross-sectional momentum (long winners, short losers) | Weak after costs | Needs shorts and many positions | Skip |
| 3 | **Index pullback in an up-trend** (Connors RSI(2) < 10 above the 200-day average, exit on a close above the 5-day average) | Long published record (book 1995–2007, no costs); later practitioner claims it held up out of sample, not independently verified | Yes: SPY/QQQ/IWM fractional, $0 commission, holds days | **Build in shadow, backtest** — cheap to test, equity sessions only |
| 4 | Crypto oversold bounce | Short-term reversal is a documented equity effect; crypto evidence mixed | Built (ADR-040) | Keep; Governor grades it |
| 5 | **Bearish regime via inverse ETFs** | Trend filters (price vs long average) mainly cut drawdowns rather than add return | Built (ADR-040) | Keep |
| 6 | Post-earnings drift (PEAD) | Recent work finds the drift has reversed since ~2002 (Li); reversals are weaker after earnings (Jegadeesh et al., RFS 2025) | Would need the earnings data we have | Skip as a rule; earnings stays a blackout + court context |
| 7 | Opening-range breakout on QQQ (Zarattini & Aziz) | Gross result replicated; **net of costs indistinguishable from zero** on five indices; the paper's 33%/yr used 4× leverage | Intraday, leverage | Skip |
| 8 | **Crypto turn-of-the-month** (hold BTC/ETH over the last and first days of a month) | Positive and significant in 2015–2021 samples; one study warns it may not beat buy-and-hold | One round trip a month: fees ~0.4% | **Shadow + backtest** — low cost to test |
| 9 | Bitcoin time-of-day (buy 21:00, sell 23:00 UTC) | One-exchange backtest; academic work finds the patterns unstable | A 0.3–0.5% round trip every day eats it | Skip |
| 10 | Funding/basis carry | Real edge for funds | Needs perp shorts or margin | Impossible at $54 |
| 11 | News/catalyst trading | What the court already does | Built (Tier 1–3) | Keep; Clairic could make its numbers exact (see below) |

## Backtest results (2026-10-24, 3 years, fees and slippage included — ADR-046)

| Strategy | Trades | Win | Expectancy | Profit factor | q (BH-FDR) | Latest third | Verdict |
|---|---|---|---|---|---|---|---|
| EQUITY_RSI2_PULLBACK_V1 | 104 | 78% | +0.27R | 2.51 | 0.000 | +0.17R | **PASS → ACTIVE on PAPER** |
| CRYPTO_BREAKOUT_BASELINE_V1 | 545 | 47% | +0.05R | 1.17 | 0.21 | −0.04R | UNPROVEN (kept as plumbing) |
| EQUITY_INVERSE_BREAKOUT_V1 | 109 | 46% | −0.06R | 0.85 | 0.98 | −0.11R | LOSES → LAB only |
| CRYPTO_OVERSOLD_BOUNCE_V1 | 184 | 44% | −0.08R | 0.68 | 0.98 | −0.01R | LOSES → LAB only |
| CRYPTO_TREND_V1 | 174 | 43% | −0.08R | 0.83 | 0.98 | −0.23R | LOSES (LAB) |
| CRYPTO_TURN_OF_MONTH_V1 | 70 | 46% | −0.14R | 0.59 | 0.98 | −0.07R | LOSES (LAB) |

The surprise is crypto trend: after 0.35% per side and pessimistic fills, this simple version loses. The literature
measures monthly rebalanced portfolios; ours trades a stop and target. It stays in LAB as a forward check, and a
lower-turnover variant is the next thing to test. The lab re-runs every Sunday and posts to #governor.

## Build queue (proposed)

1. **Backtest lab** (GitHub Actions, Python, free): replay each candidate rule over 3+ years of Alpaca daily bars
   with our fee, spread and $10-minimum model, report expectancy in R, profit factor, max drawdown, bootstrap p-value,
   and BH-FDR across all candidates. Output goes to `#governor` and gates promotion: SHADOW → ACTIVE only by PR.
   Also run it on the strategies already live (breakout baseline, bounce, inverse ETFs) so they are judged the same way.
2. `CRYPTO_TREND_V1`: multi-lookback time-series momentum (e.g. 20/50/100-day returns all positive, or price above a
   rising EMA50), entry on a pullback-to-EMA or new high, ATR trailing stop, no fixed target; volatility-scaled through
   the existing sizer. Ranked so the 1–2 strongest trends get the slots.
3. `EQUITY_RSI2_PULLBACK_V1`: SPY/QQQ/IWM above SMA200 with RSI(2) < 10; exit on a close above SMA5 or 5 days;
   2-ATR stop (required by U4). Equity posture must allow entries.
4. `CRYPTO_TURN_OF_MONTH_V1`: BTC/ETH from the second-to-last day of a month to the second day of the next; stop 2 ATR.
5. Clairic fact extraction (separate ADR): typed numbers from promoted headlines and filings into court evidence,
   with code re-checking any arithmetic and only confidence ≥ 0.8 values shown as facts.

Items 2–4 start as SHADOW and are promoted only if the backtest lab and then live PAPER grading agree.

## Sources

- Han, Kang & Ryu, time-series vs cross-sectional momentum in crypto under realistic costs: [econpapers](https://econpapers.repec.org/RePEc:eee:ecofin:v:57:y:2021:i:c:s1062940821000590)
- Barbon & Beneder, *Catching Crypto Trends*: [abarbon.com](https://abarbon.com/papers/catching-crypto-trends)
- Adaptive crypto trend-following preprint (2026, unreviewed): [arXiv 2602.11708](https://arxiv.org/pdf/2602.11708)
- Jegadeesh, Luo, Subrahmanyam & Titman, short-term reversals and momentum (RFS 2025): [citedrive](https://www.citedrive.com/en/discovery/short-term-reversals-and-longer-term-momentum-around-the-world-theory-and-evidence/)
- Earnings-announcement reversal: [Quantpedia](https://quantpedia.com/strategies/reversal-during-earnings-announcements)
- Opening-range breakout replication, net of costs: [mql5 blog](https://www.mql5.com/en/blogs/post/776235); summary: [CXO Advisory](https://www.cxoadvisory.com/technical-trading/day-trading-with-an-opening-range-breakout-strategy)
- Connors RSI(2) commentary: [CXO Advisory](https://www.cxoadvisory.com/technical-trading/a-few-notes-on-short-term-trading-strategies-that-work/)
- Bitcoin calendar effects: [Quantpedia](https://quantpedia.com/are-there-any-simple-calendar-effects-in-bitcoin-market/); Baur et al.: [UWA](https://research-repository.uwa.edu.au/en/publications/bitcoin-time-of-day-day-of-week-and-month-of-year-effects-in-retu/)
- Crypto turn-of-the-month: [Applied Finance Letters](https://ojs.aut.ac.nz/applied-finance-letters/article/download/266/85), [Emerald (2023)](https://emerald.com/insight/content/doi/10.1108/MF-02-2022-0084/full/html)
- VCP claims without published method: [tradingqna](https://tradingqna.com/t/a-25-year-empirical-study-on-minervinis-volatility-contraction-pattern-vcp-what-2-35m-data-points-reveal-about-market-crashes/198732.md)
