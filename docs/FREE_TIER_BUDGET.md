# Free-Tier Budget

Operating cost target: **$0.00/month.** All limits verified 2026-10-22 unless marked (3p) = third-party
source. Daily limits reset 00:00 UTC. Cloudflare free limits **hard-fail** when exceeded, so `FreeTierBudget`
puts the system in `REDUCE_ONLY` at 90% of any limit (constitution untouchable #6) and in `THRIFT` at 70%.

## Cloudflare

| Resource | Free limit | Planned use/day | Thrift (70%) | Hard stop (90%) | Notes |
|---|---|---|---|---|---|
| Worker requests | 100,000 | ~3,000 | 70,000 | 90,000 | Discord, ingest, health, cron; static assets are free |
| Worker CPU / HTTP or cron invocation | 10 ms | routing only | — | — | heavy work lives in the DO |
| Subrequests / invocation | 50 (1,000 to CF services) | ~14 per pulse | — | 45 | enforced per pulse |
| Cron triggers / account | 5 | 2 (`cortex` */5, `sentinel` */1) | — | — | 3 spare |
| DO requests | 100,000 | ~2,500 | 70,000 | 90,000 | alarms 1,440 max + RPC + WS/20 |
| DO duration | 13,000 GB-s | ~400–800 | 9,100 | 11,700 | **no always-on outbound sockets** (would be 10,800) |
| DO SQLite rows written | 100,000 | ~15,000 | 70,000 | 90,000 | batch writes; no per-tick churn |
| DO SQLite rows read | 5,000,000 | ~200,000 | — | 4,500,000 | |
| DO storage | 5 GB total | <50 MB | — | — | hot state only |
| D1 rows written | 100,000 (3p for exact figure) | ~5,000 | 70,000 | 90,000 | journal + logs |
| D1 rows read | 5,000,000 (3p) | ~100,000 | — | 4,500,000 | Governor reads weekly |
| D1 storage | 500 MB/DB, 5 GB total | grows ~1–3 MB/day | — | 450 MB/DB | monthly roll-up job if needed |
| Workflows | 100k exec/day shared; 100 concurrent; 10 ms CPU/step | ≤20 sprints | — | — | I/O-only steps |
| Workers AI | **10,000 neurons** | see below | 7,000 | 9,000 | hard fail when exhausted |
| Workers KV (`FLAGS`) | 100k reads, 1k writes/day | ~1,440 reads, ~0 writes | — | — | kill flag (ADR-015) |
| Bundle size | 3 MB compressed (Workflows doc) | 152 KB gzip (Phase 1) | — | — | no satori/resvg/Agents SDK |

### Workers AI neuron allocation (per UTC day)

| Use | Model | Rate (neurons / 1M input tok) | Allocation | ≈ Capacity |
|---|---|---|---|---|
| Tier 1 triage | clef-flash | 3,455 | 3,000 | ~870k tokens ≈ 900 batched items at ~1k tok, or ~50 batch calls of 16 items |
| Tier 2 structure | clef | 21,818 | 4,000 | ~183k tokens ≈ 45 candidates at 4k tok |
| Tier 3 fallback | gpt-oss-120b | 31,818 in / 68,182 out | 1,500 | ~9 calls at 3k in / 1k out |
| Reserve | — | — | 1,500 | exits/postmortems never starve |

The meter estimates neurons from token counts *before* the call (chars/3.5 heuristic, then corrected with
`usage` from the response when provided). If an allocation is exhausted, that tier pauses until reset; Tier
0 and exits keep running.

## GitHub Actions

| Resource | Limit | Use |
|---|---|---|
| Minutes (public repo, standard runners) | free | CI ~3 min/push; research ~5 min × ~10/day; governor ~10 min/week |
| Schedule granularity | ≥5 min, UTC, may delay 15–30 min or skip | batch jobs carry `produced_at`; brain checks staleness |
| Inactivity | schedules auto-disable after 60 days of no repo activity | Governor PRs + a monthly keepalive commit; brain alarms on stale batch |
| Secrets | free | `CLOUDFLARE_API_TOKEN`, `INGEST_HMAC_SECRET`, `DISCORD_WEBHOOK_GOVERNOR`, data API keys |

If the repo ever goes private: 2,000 min/month free still covers this (~1,700 min/month projected).

## LLM providers (Tier 3) — all $0, all volatile (3p)

| Provider | Free limits | Role | Notes |
|---|---|---|---|
| Google Gemini (AI Studio) | console-only limits | Bull (primary) | free-tier prompts may be used for training → send market data only |
| Groq | ~30 RPM, 1K RPD, 200K TPD per model | Bear (primary, gpt-oss-120b) | different family from Gemini |
| NVIDIA NIM | ~40 RPM | Bear fallback (nemotron) | requires NVIDIA Developer Program (free) |
| OpenRouter `:free` | 20 RPM, 50 RPD | last-resort fallback | free hosts may log prompts |
| Mistral | ~$10/month credits | optional fallback | opt out of training |
| Workers AI gpt-oss-120b | neurons | emergency fallback | same family as Groq gpt-oss → only valid as bull fallback |

Court quota: doctrine caps Tier 3 sprints at 12/day (≤36 LLM calls). Far below every provider's RPD.
Cross-family rule is enforced by `doctrine.llm_routing.families`; if no different-family bear is
available, the sprint is **rejected**, not run single-family.

## Market data

| Source | Limit | Use |
|---|---|---|
| Alpaca data (free) | 200 req/min; IEX only; options indicative; no last-15-min historical bars | quotes, bars, news, crypto |
| SEC EDGAR | 10 req/s, contact User-Agent | 8-K, Form 4 (batch) |
| CFTC COT (Socrata) | generous | weekly batch |
| CoinGecko Demo | ~10k credits/month (3p) | crypto breadth (4-hourly batch ≈ 6×30 days ≈ 180 calls × few) |
| OKX / Hyperliquid / Coinbase / Kraken / Deribit public | per-exchange public limits | funding, OI, IV |
| FRED | free key | macro series, VIX close |
| Polymarket Gamma | public | macro odds (read-only, later phase) |
| QuickChart | public endpoint, rate-limited | Discord chart images |

## What a "budget breach" does

| Level | Trigger | Behavior |
|---|---|---|
| NORMAL | all < 70% | full funnel |
| THRIFT | any ≥ 70% | pulse 120 s when flat; Tier 1 batch size up; Tier 3 paused; HUD every 30 s |
| REDUCE_ONLY | any ≥ 90%, or any limit error observed | no new entries; exits + stops only; Discord alarm |
| BLACKOUT | DO itself erroring | sentinel takes over (broker stops already in place) |
