# Third-party notices

CORTEX-54 ports or wraps code and methodology from the following MIT-licensed projects. Ported files keep
their original copyright header; each port is listed here when it lands.

| Project | License | Used for |
|---|---|---|
| [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) | MIT | risk/sizing/regime/screener skills (see `config/skills-index.yaml`) |
| [staskh/trading_skills](https://github.com/staskh/trading_skills) | MIT | Black-Scholes/Greeks, spreads, PMCC rubric, technicals, Piotroski |
| [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) | MIT | candlestick foundation model, run from a pinned checkout (`67b630e`) in `research.yml` job=kronos; weights `NeoQuasar/Kronos-base` + `Kronos-Tokenizer-base` from Hugging Face. No code copied (ADR-041) |
| [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | MIT | QR codes in the app (phone alerts, phone pairing; npm `qrcode-generator`, bundled unmodified, ADR-076) |

Ideas only (no code copied):
- HKUDS/AI-Trader and HKUDS/Vibe-Trading — no license file at time of review (2026-10-22).
- TauricResearch/TradingAgents, FinMem, FinRobot, freqtrade, hummingbot, jesse, OpenBB, qlib —
  architectural patterns described in the original design document.

## Ported files

| File | From | Upstream commit | Changes |
|---|---|---|---|
| `research/cortex_research/options/bs.py` | staskh/trading_skills `src/trading_skills/black_scholes.py` | b71a74fe327b12e314fc96618d7131dca4638ab3 | scipy → `math.erf`; trimmed to price/delta/vega/IV |
| `research/cortex_research/options/structures.py` (PMCC rubric functions) | staskh/trading_skills `src/trading_skills/scanner_pmcc.py` | b71a74fe327b12e314fc96618d7131dca4638ab3 | condensed scoring; earnings term dropped; Alpaca data instead of yfinance |

### staskh/trading_skills license

```
MIT License

Copyright (c) 2026 staskh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
