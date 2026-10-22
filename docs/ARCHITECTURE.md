# CORTEX-54 Architecture (Free Edition)

Status: authoritative. Supersedes spec §3, §4.3, §7, §12 where they conflict. Reasons in `DECISIONS.md`.

## 1. Deployables

| Unit | Runtime | Triggers | Owns |
|---|---|---|---|
| `cortex` worker | Workers Free | HTTP, cron `*/5 * * * *` | routing, Discord interactions, ingest, health, web API (later) |
| `AgentCortexDO` (`CORTEX-54-PRIMARY`) | Durable Object (SQLite) | alarm, RPC from `cortex` | all trading state and decisions |
| `ResearchSprintWorkflow` | Workflows Free | created by DO | Tier 3 court → `DecisionContract` |
| D1 `cortex-journal` | D1 Free | — | append-only history and analytics tables |
| `sentinel` worker | Workers Free (separate deploy) | cron `* * * * *`, HTTP | watchdog, independent loss check, flatten-all |
| GitHub Actions | public repo runners | push, schedule | CI/CD, Python research batch, weekly Governor |
| Discord app **CORTEX** | — | interactions → `cortex` | C2 cockpit |
| Discord app **SENTINEL** | — | interactions → `sentinel` | `/kill`, `/status-sentinel` only |

Two Discord apps because one app has exactly one interactions endpoint; the kill path must not depend on
the brain's worker being healthy.

## 2. The pulse (heart of the system)

The DO schedules its own alarm. No long-lived outbound sockets.

```
alarm() ─┬─ 0. load hot state; if KILLED → reconcile only, re-arm, return
         ├─ 1. FreeTierBudget.snapshot() → mode (NORMAL | THRIFT | REDUCE_ONLY)
         ├─ 2. per account (PAPER, LIVE), in parallel:
         │      GET /v2/account, /v2/positions, /v2/orders?status=open,
         │      /v2/account/activities?activity_types=FILL&after=<cursor>
         │      → reconcile vs hot state (broker is source of truth); mismatch → REDUCE_ONLY + alert
         ├─ 3. quotes for held + watchlist symbols (1 stock snapshot call, 1 crypto quote call)
         ├─ 4. Tier 0: synthetic stops/targets/time-stops, breaker ladder, staleness, settlement
         │      → exit orders go out first, before any new-entry work
         ├─ 5. intake: news since cursor (1 call) + ingested batch candidates (D1)
         │      → Tier 0 relevance/dedupe → Tier 1 Clef-flash (batched) → Tier 2 Clef
         │      → promote top candidates: create ResearchSprintWorkflow (bounded per day)
         ├─ 6. execute ready contracts: reserve → size → validate → submit (per account, per dial)
         ├─ 7. journal writes (batched D1), heartbeat, HUD patch (debounced ≥5 s)
         └─ 8. next alarm: 60 s if any position/open order or an equity session is open; else 300 s
```

Subrequest budget per pulse ≈ 2×4 (accounts) + 2 (quotes) + 1 (news) + ≤2 (AI) + ≤1 (Discord) ≈ 14 of 50.
D1 and Workers AI count against the separate 1,000 Cloudflare-service cap.

Wall time per pulse target: <2 s (parallel fetches). Duration ≈ 1,440 pulses × 2 s × 0.125 GB ≈ 360 GB-s/day.

### Fills without WebSockets
Fills are discovered via `account/activities` (FILL) with a persisted cursor, plus order status polling for
open orders. Worst-case detection latency = one pulse (60 s). Acceptable for the 24–72 h holding periods
the $54 doctrine targets. A "hot mode" (temporary outbound stream) is a later optimization gated by the
duration budget meter; it is off by default.

### Stops without WebSockets
- **Primary:** broker-side stop where Alpaca accepts it — crypto `stop_limit` GTC; equity fractional `stop` /
  `stop_limit` in regular hours. Placed immediately after entry fill.
- **Secondary:** synthetic stop checked every pulse (covers extended hours and gaps where broker stops can't
  be used). Breach → marketable limit exit with a price collar.
- **Tertiary:** `sentinel` independently checks LIVE account daily loss each minute and flattens on breach.

## 3. Concurrency model (risk reservations)

DO is single-threaded but `await` yields. Two intake events can interleave. Rule:

1. Synchronously (no await) in one SQLite transaction: compute available heat and slot count, insert a
   `risk_reservations` row (`contract_id, account, risk_cents, notional_cents, expires_at`).
2. Only then `await` the broker submit.
3. On ack: convert reservation → order. On reject/timeout: release reservation.
4. Expired reservations are swept every pulse.

Heat and slot checks always count `positions + open orders + live reservations`.

## 4. Order state machine (in the DO, not a Workflow)

`PLANNED → RESERVED → SUBMITTED → (PARTIAL)* → FILLED → PROTECTED (stop placed) → EXITING → CLOSED`
with side exits `REJECTED`, `CANCELED`, `EXPIRED`, `ORPHANED` (broker has it, we don't → alert + adopt or
flatten). Re-peg policy: crypto/equity limit pegged at best bid (buys) / best ask (sells) or 1 tick inside;
re-evaluate each pulse; cancel after `doctrine.execution.max_unfilled_pulses`; never cross the spread
unless `urgency = IMMEDIATE` and the fee hurdle still clears at taker rates.

Idempotency: `client_order_id = c54-{P|L}-{contract8}-{E|S|X}-{attempt}` (entry/stop/exit). A retried submit
with the same id is safe; Alpaca rejects duplicates and the brain adopts the existing order. Open broker orders
with our prefix that the DO doesn't know (crash between submit and record) are adopted on the next sync;
anything else unknown → REDUCE_ONLY + alert.

Phase 1 implementation: `src/cortex/Brain.ts` (logic), `src/cortex/AgentCortexDO.ts` (host). Stale passive
entries are cancelled, not re-pegged (ADR-017).

## 5. Paper ↔ Live twin

One brain, one contract, two executions:
- Each account has its own equity, rung, breaker state, settlement ledger and autonomy dial.
- Sizing is per account (both start at $54, so initially identical).
- LIVE executes only if: dial ≥ Stop 3, or dial = Stop 1 and the operator pressed ✅ within the contract TTL.
- Divergence metrics (entry slippage bps, fill rate, fee bps, P&L gap) are journaled per contract.
- Paper fills get our fee + slippage model applied in the ledger (Alpaca paper charges nothing), so paper
  P&L is the honest pessimistic estimate used for graduation.

## 6. Storage split

**DO SQLite (hot, transactional, small):** `settings`, `accounts`, `positions`, `lots` (settlement),
`orders`, `risk_reservations`, `breaker_state`, `regime_state`, `scar_rules` (loaded from config at deploy),
`cursors`, `budget_counters`, `pending_approvals`, `hud_state`, `triage_queue`.

**D1 (append-only history, queryable from Actions):** see `migrations/0001_initial_schema.sql` —
`journal` (hash-chained), `decision_contracts`, `orders_log`, `fills`, `rejections` (shadow ledger),
`triage_log`, `beliefs`, `source_reputation`, `skill_fitness`, `governor_proposals`, `budget_daily`,
`batch_results`, `llm_calls`.

Why both: DO SQLite gives zero-latency transactional state for the risk path; D1 gives a durable,
externally-queryable record (Actions read it via `wrangler d1 execute --remote`) that survives a DO wipe.

## 7. Cognitive funnel detail

**Tier 0 (code):** symbol relevance (held/watchlist/universe), headline dedupe (normalized hash, 24 h),
staleness, spread ≤ doctrine max, fee hurdle (`expected_move ≥ 3 × (fee_rt + spread/2)`), regime gate
(crypto composite < 40 → no long crypto entries; equity posture REDUCE_ONLY/CASH_PRIORITY → no entries).

**Tier 1 (clef-flash):** one request carries a *batch* state (`items: [...]` up to ~16) and per-item
questions (≤64 total): `material_catalyst` (noul), `direction` (choice), `already_priced` (noul),
`escalate` (score: Reject / Watchlist / Shadow / Deep). Threshold from doctrine (default 0.70).

**Tier 2 (clef):** one candidate per request with full JSON state: regime posture, technicals (computed in
Tier 0), batch skill outputs, scar rules. Questions: `regime_alignment`, `setup_class`,
`bear_lethality`, `structural_quality` (score). Pass → Tier 3 if daily court quota remains.

**Tier 3 (ResearchSprintWorkflow):**
1. `gather-evidence` — read batch skill outputs + live quotes → `EvidenceBundle` with provenance.
2. `bull-advocate` — provider A (default Gemini). JSON: thesis ≤280c, instrument, entry zone, stop, targets,
   horizon, conviction 1–10, receipts referencing evidence ids only.
3. `bear-prosecutor` — provider B from a **different model family** (default Groq gpt-oss-120b). JSON:
   fatal flaws, kill criteria, `bear_lethality` 0–1.
4. `synthesize` — Clef scores both briefs; disagreement penalty `D_bear` computed in code from the gap.
5. `emit-contract` — schema-validate; persist to D1; hand to DO via RPC. Rejected → `rejections`.

Every step is I/O-bound (≤10 ms CPU). Retries: 2 with backoff; provider failover via the routing chain in
`doctrine.yaml`.

## 8. Memory

| Organ | Store | Write rule | Read rule |
|---|---|---|---|
| Episodic | D1 `journal`, `decision_contracts`, `fills`, `rejections` | append-only, hash-chained | Governor, postmortems, HUD |
| Semantic beliefs | D1 `beliefs` | Governor or postmortem job | confidence `C0·e^(−λΔt)` (60 d half-life; 180 d when STRUCTURAL); < 0.35 → not injected |
| Scar tissue | `config/scar-tissue.yaml` → DO `scar_rules` | **PR only**, needs ≥3 episodic matches | injected into Tier 2/3 state; some compile to Tier 0 hard filters |
| Regime | DO `regime_state` | pulse + batch ingest | every decision |

## 9. Batch research (GitHub Actions, Python)

`research.yml` (added in Phase 2), schedules in UTC with slack for delays:
- equities pre-open job: breadth, distribution days, FTD, uptrend, VCP/momentum-burst screeners, earnings
  calendar → `POST /ingest/batch` (HMAC-SHA256 over body with `INGEST_HMAC_SECRET`).
- crypto every 4 h: crypto regime (OKX/Hyperliquid funding, CoinGecko breadth).
- weekly: COT (CFTC Socrata), insider Form 4 clusters (EDGAR).

The brain stores batches in D1 `batch_results` with `produced_at`; any consumer older than doctrine
staleness limits is ignored and raises a staleness alert.

`governor.yml` (Phase 4), weekly: pulls the journal, computes Brier/reliability per tier, isotonic
calibration, Monte Carlo bootstrap (2,000 permutations), BH-FDR across skills, rejection-ledger inverted
filter checks → opens a PR touching `config/doctrine.yaml`, `config/calibration.json`,
`config/scar-tissue.yaml`, plus posts the report card to Discord.

## 10. Discord C2

- Interactions endpoint `POST /discord/interactions` on `cortex`: Ed25519 verify (WebCrypto), respond within
  3 s. Fast actions answer inline; anything touching the DO returns a deferred response (type 5/6) and the DO
  edits via the follow-up webhook (valid 15 min). The callback response is the last thing the handler does.
- Pinned command-center message: embeds + components, edited in place at most once per 5 s.
  Charts are QuickChart image URLs (rendered off-platform; zero Worker CPU).
- Channels: `command-center`, `pulse-and-briefs`, `bull-vs-bear-court`, `live-executions`,
  `world-intel-stream`, `governor-and-evolution`, `alarms-and-watchdog`, `agent-terminal`.
- Authorization: every mutating interaction checks `member.user.id == OPERATOR_DISCORD_ID`.

## 11. Web terminal (Phase 6)

Static assets on the same `cortex` worker (static asset requests are free). React SPA. Auth: Discord OAuth2,
allow-list of the operator ID, HMAC-signed session cookie. Live state via a hibernatable inbound WebSocket
to the DO (incoming messages billed 20:1, outgoing free). Workspaces built first: Command Deck,
Cortex & Clef Studio, Memory Vault. Others later.

## 12. Sentinel

- Cron every minute: `GET cortex/health` (checks DO `last_pulse_at`). Missed > 3 min → Discord webhook alert;
  > 15 min with LIVE positions open → place/verify broker-side stops directly (it has its own LIVE keys copy).
- Independent LIVE daily-loss check from Alpaca `/v2/account` (`equity` vs `last_equity`). Breach of
  constitution daily loss → cancel all orders + close all positions + set a "KILLED" flag the brain reads.
- `/kill` slash command (SENTINEL app) → same flatten path. Requires the operator ID. `/rearm` clears the flag,
  `/sentinel` shows it.
- Kill state is the KV key `killed` in the shared `FLAGS` namespace (ADR-015). Brain-death flatten fires after
  `FLATTEN_ON_BRAIN_DEATH_MINUTES` (default 60) only if LIVE holds positions.
- Kept tiny: no shared modules with `cortex` except a vendored, frozen copy of the HMAC/Ed25519 helpers.
