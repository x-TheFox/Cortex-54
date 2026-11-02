# Verified facts

Moved from CLAUDE.md §4 on 2026-11-02. Checked 2026-10-22; re-verify anything older than ~60 days,
then update this file with the date (CLAUDE.md §10).

## Verified facts (checked 2026-10-22; re-verify anything older than ~60 days)

**Cloudflare Workers Free**
- 100k Worker requests/day. **10 ms CPU** per HTTP request and per cron invocation. 50 subrequests per
  invocation (1,000 to Cloudflare services like D1/AI). 5 cron triggers per account. 128 MB memory.
  Bundle: design for ≤3 MB compressed (the Workflows docs state 3 MB on Free).
- Durable Objects on Free: SQLite backend only. 100k requests/day, **13,000 GB-s duration/day**, 5M rows
  read + 100k rows written/day, 5 GB storage. WebSocket incoming messages count 20:1; outgoing are free.
- **Outbound WebSockets from a DO cannot hibernate** and keep it billed for wall-clock. An always-on 128 MB DO
  costs 10,800 GB-s/day (83% of the free allowance). Hence the alarm-pulse design.
- Exceeding any free limit → operations **fail with errors** until 00:00 UTC. Fail-closed matters here.
- Workflows on Free: 10 ms CPU per step, 1,024 steps per workflow, 100 concurrent instances, 3-day
  retention, executions share the 100k/day request pool.
- D1 on Free: 10 DBs, 500 MB per DB, 5 GB total, 50 queries per invocation, 100 bound params per query.
- Workers AI Free: **10,000 neurons/day**, hard fail when exhausted. Rates (neurons per 1M input tokens):
  clef-flash 3,455; clef 21,818; gpt-oss-120b 31,818 in / 68,182 out; llama-3.3-70b 26,668 in / 204,805 out.
  Clef output is not listed as billed.
- **Not available on our plan:** Containers (paid only); RL fine-tuning for Clef (design-partner only).
  **Avoided:** R2 and Zero Trust (may require a payment method on file).

**Clef** (launched 2026-10-01; API verified live 2026-10-22): `@cf/cloudflare/clef` (27B, vision, ≤4 images)
and `@cf/cloudflare/clef-flash` (9B). **Context window 24,576 tokens** (questions + state; state is truncated to
fit; *not* 64K as third parties claimed). ≤64 questions/request. Request
`{model, state, questions:{id:{type, instructions, criteria?}}}`; response `answers[id]` =
`{type:"noul", noul}` | `{type:"choice", choice, probabilities, confidence}` | `{type:"score", score (0..n-1),
probabilities, legend, confidence}`, plus `usage.input_tokens`. clef-flash ≈ $0.038/M input tokens (= 3,455
neurons/M); output free. **Batching several items into one state compresses and reorders scores — score one
item per call (ADR-027).** `clef-omni` (30B MoE, 3B active) appeared in our Workers AI catalog by 2026-10-24 but is
unused. **Clairic** `@cf/cloudflare/clairic` (preview, verified live 2026-10-24): extraction model, request
`{model:"clairic", state, fields:{id:{type: text|date|number|list|estimate, instructions, …}}, reference_date}`,
answers carry `value` + `confidence` (estimates: mean/p10/p90), 65,536-token context, $0.10/M input ≈ 9,091
neurons/M, no output billing (ADR-043). **Jev** (TypeSafe AI) is not in our Workers AI catalog (2026-10-24).

**Alpaca**
- Crypto: market / limit / stop_limit, TIF gtc / ioc, all fractional. **No `post_only` flag.** **Minimum order
  cost basis $10** (403 40310000, verified 2026-10-24; ADR-042 lifts risk-sized orders to it inside the caps). Fee tier
  <$100k 30-day volume: 0.15% maker / 0.25% taker. Paper does not charge fees.
- Equities: $0 commission; regulatory fees on sells round up to the cent (meaningful on $18 sells).
  Fractional supports market, limit, **stop, stop_limit** (regular hours). Extended hours: limit orders only
  (TIF day/gtc). Overnight session 8 pm–4 am ET Sun–Fri (fractional overnight coverage unclear, verify).
- Paper: market buys fill at ask / sells at bid; limit fills when touched (no queue); ~10% random partial
  fills; no fees, no slippage model. **We apply our own fee + slippage model to paper fills.**
- Paper equity can be reset to a custom amount (dashboard "Reset" → new API keys).
- A second $54 paper account (LAB, verified 2026-10-24: cash, crypto enabled) backs the LAB brain (ADR-045). Its keys
  are `ALPACA_LAB_KEY_ID/SECRET` (cortex + GitHub secrets).
- Free data plan: equities IEX-only; options "indicative" feed; 200 REST calls/min; latest 15 min of
  historical bars not queryable; WebSocket symbol cap (historically 30). Crypto data is free.
- PDT rule removed by FINRA effective 2026-06-04 (broker phase-in to 2027-10-20). For a $54 cash account the
  binding constraint is **T+1 settled cash / good-faith violations**, not PDT.
- Options levels: L1 covered/CSP, L2 long calls/puts, L3 spreads. The smallest defined-risk spread (~$15–35
  max loss) exceeds our per-trade risk cap until equity is ~$1,000+. **Options are paper-only (shadow lab)
  until the sizer itself permits them.**

**Data & LLM free tiers (third-party sourced, volatile — the code must degrade gracefully)**
- Groq ~30 RPM / 1K RPD / 200K TPD per model (gpt-oss-120b, gpt-oss-20b, qwen3.8-27b). **Verified 2026-10-22:**
  `openai/gpt-oss-120b` (with `reasoning_effort: low`) and `qwen/qwen3.8-27b` return JSON-mode output.
- Gemini (AI Studio) free: **use the Interactions API** (`POST /v1beta/interactions`, `response_format` with a JSON
  schema). `generateContent` 404s for current models and `gemini-2.5-flash` is closed to new users.
  `gemini-3.5-flash` ≈ 7–25 s; `gemini-3.8-flash` is often 503 "high demand". Prompts may be used for training.
- **Re-verified 2026-10-26 (bull prompt, live BTC):** Gemini 3.5/3.8 returned 503 "high demand" at peak (3.5 answered ~14–20 s
  later); qwen and gpt-oss-20b answer in ~2 s; nemotron (NIM and OpenRouter) answers in prose, not JSON; deepseek-v4.1-flash
  times out at 60 s (out of the court chains, ADR-056).
- **Canary 2026-10-26 (ADR-070):** Gemini 3.5/3.8 both 503 "high demand"; Groq `qwen/qwen3.8-27b` fails Groq's JSON
  validation (400) and its TPM cap on a 3–4K prompt; gpt-oss-20b/120b answer valid JSON in ~1.2 s; NIM Nemotron is
  valid 4/4 only with a ≥ 4,096-token output budget (it reasons first; at 1,500 it was cut off). Groq on this key also
  lists allam-2-7b, whisper and prompt-guard only. NIM kimi-k2.6, mistral-large-2, gemma-3 return 404 ("Function not
  found") and glm-5.3 times out at 60 s.
- Alpaca crypto quotes and bars work **without keys**; news needs keys (local demo mode relies on this, 2026-10-26).
- Chronos-2 (`amazon/chronos-2`, Apache-2.0) loads on CPU in ~65 s (first download) and forecasts in ~0.2 s per series.
- NVIDIA NIM: enabled for this key — `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`
  (`nemotron-3-super` is *not* enabled). OpenRouter `:free` errored on every test (left out of chains).
- **Verified 2026-10-24 (ADR-051):** Gemini Google Search grounding has no free quota; Groq `compound` is not on our key
  and `gpt-oss-120b` is capped at 8K tokens/min; NIM `nvidia/nemotron-3-ultra-550b-a55b` ≈3 s JSON (NIM
  `deepseek-v4.1-flash` timed out); OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` works (≈13 s), most other
  `:free` models are rate-limited or harness-only. Keyless web: DuckDuckGo HTML, Google/Bing News RSS, Wikipedia REST,
  Jina reader (`r.jina.ai`). The LLM keys are also GitHub secrets for the research desk.
- CoinGecko Demo ~10k credits/month. SEC EDGAR 10 req/s with a contact User-Agent.
- **Binance/Bybit block US IPs** (and GitHub runners are US). Use OKX / Hyperliquid / Coinbase / Kraken /
  Deribit public endpoints for funding, OI and IV. The tradermonty `crypto-regime-analyzer` uses Binance;
  our port swaps the funding source.
- Verified 2026-10-22: Alpaca news (Benzinga) is on the free plan; OKX public funding works from US; GDELT DOC
  2.0 API is free/keyless (≤1 req / 5 s); upstream tradermonty breadth/uptrend run keyless; FTD/macro/market-top
  run on the FMP free key; exposure-coach combines them.
- GitHub Actions: public repo → free standard runners. Cron is UTC, can be delayed 15–30 min or skipped, and
  **scheduled workflows auto-disable after 60 days of repo inactivity.** The brain alarms on stale batch data.

**Licenses:** `tradermonty/claude-trading-skills` MIT, `staskh/trading_skills` MIT → port with attribution
(`NOTICE.md`). `HKUDS/AI-Trader` has **no license** → ideas only, never copy code.
