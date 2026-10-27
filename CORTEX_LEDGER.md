# CORTEX_LEDGER.md

**Purpose:** Single inherited research ledger for the CORTEX-54 landing-page effort. Written by a full-repo sweep
(2026-10-27, main @ c609584; five area sweeps merged). Later agents (landing-page coding agent) should **extend
this file**, not replace it. Every factual claim carries a file (and line where useful) so nothing is invented.

---

## 1. What Cortex is (plain language)

CORTEX-54 is an autonomous trading agent that runs **entirely on free tiers** (Cloudflare Workers Free, GitHub
Actions on a public repo, free LLM APIs, free market data) and trades two Alpaca accounts in lockstep: a
**$54 paper account** and a **$54 real-money account**. It reads the real world (news, filings, crypto
microstructure, regime data), filters it through a four-tier cognitive funnel that "spends thinking like money,"
and may only trade through a schema-valid `DecisionContract` that a deterministic risk engine sizes and can veto.
Trading is fully autonomous: no human approves trades. (CLAUDE.md §1 lines 10–20)

Tagline logic, verbatim in the code and README: **"Models reason, code computes, the risk engine decides, the
operator governs."** (README.md:7; CLAUDE.md:20). A court-card footer variant: "models argue, code computes, the
risk engine decides" (src/cortex/cards.ts:683-688).

**Why "54":** it is the account size in dollars — $54 paper + $54 live (README.md:3-4). The number is the budget
made visible; the whole design philosophy is "a $54 scale where every cent and basis point is visible"
(PRODUCT.md:38).

**The product today (what a customer buys):** closed-source software the customer runs themselves
(CLAUDE.md:25-28; docs/DISTRIBUTION.md:2-4) —
1. a **desktop app** (macOS/Windows/Linux, Tauri v2): "The whole brain, the cockpit and a tray pill in one
   installer. Starts in a keyless demo on live crypto prices; paper mode with the customer's own free Alpaca
   paper account." (docs/DISTRIBUTION.md:8-9)
2. a **headless Docker image** for home server / NAS / VPS (docs/DISTRIBUTION.md:10-11)
3. a paste-into-any-AI-agent **setup prompt** (docs/SETUP_WITH_AN_AGENT.md)
4. one hosted **community hub** — signed track records, leaderboard, memory packs; "it never touches anyone's
   broker keys or money" (docs/DISTRIBUTION.md:4,13)
5. **Ed25519-signed licences** checked offline + minisign-signed auto-updates (docs/DISTRIBUTION.md:14)

**v0.1.0 shipped for every platform on 2026-10-27** (CLAUDE.md §11 line 492; docs/IDEAS_WORKLOG.md:526).

App-first pivot (ADR-071, docs/DECISIONS.md:927): "the app is the dashboard; Discord is an optional add-on."
Note the README (line 5) still says "controlled from Discord" — the README lags the ADRs; ADR-071+ win.

## 2. Hard, verifiable claims & numbers (each with its source)

**Cost & scale**
- "$0 operating cost. No paid plans, no credit cards on file, ever." (CLAUDE.md:22-23); "$0.00/month" itemised
  service-by-service in docs/FREE_TIER_BUDGET.md:3-26 (Workers 100k req/day, DO 13,000 GB-s/day, Workers AI
  10,000 neurons/day, D1 5 GB, GitHub Actions free on public repo…)
- Brain worker bundle ~152 KB gzip vs 3 MB Free budget (CLAUDE.md:337; docs/FREE_TIER_BUDGET.md:26)
- Codebase: ~72 TS files / 17,335 LOC under src/ (sweep 2-a); Brain.ts alone 6,362 lines
- 12 metered budget resources with NORMAL/THRIFT(70%)/REDUCE_ONLY(90%) modes (src/budget/FreeTierBudget.ts:11-23)

**The thinking funnel** (CLAUDE.md §3 table lines 94-101; README.md:8-9)
- Tier 0 Reflex — TypeScript, free: stops, breakers, staleness, spread/fee gates, dedupe, ALL arithmetic
- Tier 1 Triage — `@cf/cloudflare/clef-flash`: ~3,000 neurons/day, ≤8 items/pulse, promote at P(material) ≥ 0.45
  & priority ≥ 1.2 (config/doctrine.yaml:118-127)
- Tier 2 Structure — `@cf/cloudflare/clef` 27B: ~4,000 neurons/day, pass 0.72, ≤40/day (doctrine.yaml:128-131)
- Tier 3 Court — free LLM chains, bull → **cross-family** bear → bull rebuttal → 3-seat expert panel
  (quant/risk/macro) → Clef 27B judge; ≤12 hearings/day (doctrine.yaml:141-153, 204-213)
- "Expensive thinking happens only on the best ~1% of ideas" (README.md:8-9)
- Live hearing ≈ 48 s; ≤ ~100 court LLM calls/day (docs/FREE_TIER_BUDGET.md:85-87)

**Risk doctrine at $54** (CLAUDE.md §6 lines 222-240; docs/RISK_DOCTRINE.md:6-67; config/doctrine.yaml:18-93)
- Per-trade risk 2.5% at R1 = **$1.35 max loss**; max position notional 35% = **$18.90**; max 3 concurrent
  positions; total heat ≤ 12%
- Worked example in docs/RISK_DOCTRINE.md:28-32: R1, $54, conviction 7 → risk budget **$0.544**, max loss ≈ **$0.54**
- Sizer caps: `N = min(E·r_eff/d_stop, E·0.35, settled_cash, heat_room/d_stop)`; stop ≥ 1.2×ATR14; round down
- Breakers (drawdown from HWM): GREEN <3% (×1.0) / YELLOW 3–6% (×0.5) / ORANGE 6–10% (reduce-only) / RED ≥10% or
  daily loss ≥5% or 3 stop-outs in 24 h (flatten + lock). Constitution ceilings: RED ≤12% DD, ≤6% daily loss
  (config/constitution.json:46-60)
- Fee hurdle: target move ≥ 3× (fees + half-spread) (doctrine.yaml:87-93); crypto maker 0.15%/taker 0.25%;
  paper accounts charge themselves modeled fees + slippage — "This is what makes paper graduation honest"
  (src/risk/fees.ts:45-46)
- Rung ladder R1–R5 with equity bands $54→$25k+ (docs/RISK_DOCTRINE.md:45-53; doctrine.yaml:18-63)

**Safety architecture**
- 8-rule constitution enforced in code, tested, operator-git-only (CLAUDE.md §2 lines 32-58; the JSON schema
  literally enforces `length(8)` — src/contracts/constitution.ts:8-10)
- Independent `sentinel` worker: per-minute cron, separate Discord app, "shares no runtime code with cortex on
  purpose — if the brain's code is broken, this still works" (workers/sentinel/wrangler.jsonc:1-2;
  workers/sentinel/src/index.ts:1-12); brain-death flatten after 60 min if LIVE holds positions
  (workers/sentinel/wrangler.jsonc:21)
- Kill flag in Workers KV written only by sentinel; **unparseable kill payload = killed (fail closed)**
  (src/cortex/Brain.ts:314-329)
- Kill switch also reachable via GitHub Actions (`gh workflow run kill-switch`) — "works even if the brain worker
  or Discord is down" (.github/workflows/kill-switch.yml:3)
- Hash-chained append-only journal: every row `sha256(prev|seq|ts|kind|payload)`; **SHA-256 implemented by hand**
  because "an await inside a Durable Object … could fork the chain" (src/journal/Journal.ts:5-17;
  src/lib/sha256.ts:1-5); 14 no-UPDATE/no-DELETE SQL triggers (migrations/0001_initial_schema.sql:234-247);
  daily chain head posted to Discord
- 6 multi-row policy invariants in plain SQL checked every pulse (order-without-contract,
  position-without-stop, …), surfaced in /health (src/cortex/Brain.ts:6112-6146)
- Every position gets a broker-side stop where Alpaca accepts one + a synthetic stop checked every pulse
  (src/cortex/Brain.ts:2237, 1757-1760); "stops only ever move up" (ADR-059)
- Idempotent order ids `c54-{P|L}-{contract8}-{E|S|X}-{attempt}` — "a retried POST can never double-fill"
  (src/lib/ids.ts:19-32)
- Prompt-injection hardening: external text wrapped as data, never given tool authority (CLAUDE.md:367);
  regression suite in test/court.test.ts:395-452; Clairic numbers must literally appear in source text
  (src/clef/clairic.ts:131-143)
- ~25 PreTradeValidator fail-closed checks gate every entry (src/risk/PreTradeValidator.ts:63-165)
- Broker adapters join only after a conformance suite + supervised paper session; rejected venues named with
  reasons (src/broker/registry.ts:3-59)
- Signed public track record: Ed25519-signed, hash-linked hub rows — "A published track record can't be edited
  after the fact without breaking signatures and hashes" (src/hub/protocol.ts:6-11)

**Status & track record (as recorded in-repo)**
- "all roadmap phases (0–6) are built and deployed. PAPER trades autonomously; a second paper account (LAB)
  forward-tests new strategies; LIVE (real money) stays dormant until PAPER passes the 30-day graduation gate
  and the operator ratifies it" (README.md:21-23)
- First fills 2026-10-24 (LAB: BTC/USD, AAVE/USD ~$10 each); first exits 2026-10-26 (+$0.08, +$0.10)
  (CLAUDE.md §11 lines 470-471)
- Backtest lab verdicts (3 years, fees+slippage, BH-FDR; docs/STRATEGY_RESEARCH.md:40-49): RSI(2) pullback
  **PASS → ACTIVE** (104 trades, 78% win, +0.27R, PF 2.51); CRYPTO_BREAKOUT_BASELINE kept as plumbing (UNPROVEN);
  4 others **LOSE net of costs → LAB only**. "a backtest that agrees with the literature is still a backtest"
  (ADR-046, docs/DECISIONS.md:524)
- No performance claims beyond these exist anywhere in the repo. Nothing about future returns, ever.

## 3. How it thinks — the cognitive funnel end-to-end

*(detail from sweep 2-a; sources: src/cortex/Brain.ts, src/court/*, src/clef/*, src/universe/*)*

**The pulse** (alarm-driven, 60 s when exposed/in-session, 300 s flat; docs/ARCHITECTURE.md:22-47): check kill →
budget snapshot → reconcile both accounts (broker = source of truth; mismatch → REDUCE_ONLY) → quotes → Tier 0
exits first → intake (news + research batches) → Tier 1 → Tier 2 → court → execute entries (8 strategy runners)
→ journal/HUD → re-arm alarm.

- **Tier 0.5 prefilter — zero neurons** (src/universe/prefilter.ts): whole-wire intake scored by 11 noise
  regexes + 13 signal regexes; near-duplicate Jaccard detection; ≤150 intake headlines/day
- **Tier 1** (clef-flash): one item per call (batching compresses scores — live finding, ADR-027); answers
  material 0–1 / direction / escalate 0–3; promotion bar material ≥ 0.45 AND escalate ≥ 1.2; an item failed 3×
  is rejected, never allowed to jam the queue (Brain.ts:4641-4659)
- **Tier 2** (Clef 27B): questions long_favored, regime_alignment, bear_lethality, setup_class,
  structural_quality 0–100; pass bar ≥ 0.72 + regime ≥ 0.5 + quality ≥ 70; one candidate per pulse
- **Research dossier** (ADR-051): a GitHub-Actions web-research desk (read-only tools: DuckDuckGo, Google/Bing
  News RSS, Wikipedia, Jina, EDGAR, Alpaca) builds a citable dossier per court case; court waits ≤ 25 min;
  findings must cite URLs the tools actually returned; ≤16 dispatches/day
- **Tier 3 — the court** (Brain.ts:4191-4580):
  1. Bull Advocate (chain A): falsifiable long thesis or `no_trade` ("If there is no clean long, set
     no_trade=true (that is a good answer)" — src/court/prompts.ts:26-35)
  2. Code checks the bull (src/court/court.ts:85-105): entry zone must bracket the bid ±0.5%, stop below entry,
     ≥1.2×ATR away, targets clipped to entry + 3·ATR·√(h/24) — "code wins"
  3. Bear Prosecutor (chain B, **must be a different model family**): 3 rotating personas (skeptic/macro/quant)
     seeded by sprint UUID; no cross-family bear available → "not traded single-family"
  4. Bull rebuttal: conviction may only stay or fall; **withdrawing ends the hearing — no trade**
     ("🏳️ The bull withdrew after cross-examination — no trade", Brain.ts:4339-4349)
  5. Expert panel: quant 📐 / risk 🛡️ / macro 🌍, advisory only, seats rotated
  6. Judge: Clef 27B synthesis → win_prob / regime_fit / bear_lethality / suitability 0–100
- **Calibration**: judge probabilities are NOT win rates until calibrated — shrunk toward 0.5 until 50 resolved
  outcomes, then the Governor's isotonic map applies (src/court/court.ts:193-203; config/calibration.json)
- **Contested-ruling tax**: bear lethality ≥ 0.5 or bull lost ≥2 conviction points → win_prob taxed
  (Brain.ts:4442-4447); every model-stated number not found in the evidence is counted per role and graded later
- **Lateness meter**: price already moved ≥0.8 ATR since the headline → refused (src/portfolio/lateness.ts)
- **Resting convictions**: contracts rejected only for "price ran past the entry zone" may wait up to 48 h and
  re-run every gate when the zone returns (ADR-060)
- **Operator shortcuts**: `/court SYMBOL` (skips Tiers 1–2, never the gates); `/roast` runs the full hearing on
  the operator's own idea and **never trades** (Brain.ts:3956-3997)

## 4. How it's governed — constitution, risk engine, kill-switch

**The 8 untouchables** (config/constitution.json:4-45, near-verbatim):
1. **No contract, no order** — every order traces to a schema-valid, persisted DecisionContract
2. **Models never size** — LLMs output conviction/probabilities only; quantity, notional, price come exclusively
   from PositionSizer + PreTradeValidator. The contract schema itself rejects a non-zero `cognitive_cost_usd`
   (it's a `z.literal(0)` — src/contracts/decision-contract.ts:64) and a court contract cannot carry
   qty/notional/size keys (test/court.test.ts:419)
3. **Hard caps, cash only** — no margin, no shorting, no naked options, no leveraged ETFs; bearish exposure only
   via 1x inverse ETFs (SH/PSQ/RWM/BITI)
4. **Every position has an exit** — broker-side stop where accepted, synthetic otherwise
5. **Kill-switch and Red breaker are sacred** — no model or Governor can override; LIVE unlock needs a written
   postmortem; PAPER self-unlocks after ≥12 h flat with a machine postmortem that counts against LIVE graduation
6. **Fail closed** — stale data, unknown broker state, reconciliation mismatch, or budget ≥90% → REDUCE_ONLY
7. **Append-only, hash-chained journal** — SQL triggers block UPDATE/DELETE; daily chain head anchored to Discord
8. **Self-modification is a pull request** — the Governor only proposes; the operator merges; no
   approve-each-trade mode exists; LIVE stays dormant until PAPER graduates + one RATIFY (in fact two:
   "real-money autonomy takes two RATIFYs, the second 10 min–24 h after the first" — Brain.ts:5894-5911)

**DecisionContract** (src/contracts/decision-contract.ts:23-113): UUIDv7 id; thesis_summary 20–280 chars;
bull_case_receipts ≥1 (evidence_id, source, metric, as_of, provenance_url); bear_case_brief; kill_criteria ≥1;
invalidation (stop_price, max_hold_hours ≤720); entry_plan (zone_low/high, urgency, targets 1–3);
clef_probabilities (raw + calibrated); win_prob_used; bear_lethality; atr; cost_and_fee_drag with
`cognitive_cost_usd: literal(0)`; proposed_conviction 1–10; models_used with roles
RULE|TRIAGE|STRUCTURE|BULL|BEAR|SYNTH. Structural rules: RULE contracts carry no Clef probabilities; COURT
contracts require probabilities, "a bear prosecution is mandatory", bull+bear "must come from different model
families".

**PositionSizer** (src/risk/PositionSizer.ts:52-123, "Deterministic position sizer (constitution U2: models
never size). Pure"):
```
r_eff   = min(rung.per_trade_risk, rung.per_trade_risk × (conviction/10) × (1 − D_bear)
              × W_rep × M_breaker × min(1, regimeMultiplier) × edgeGate(pWin))
edgeGate(p)  = clamp((p − 0.5)/0.25, 0, 1)          # no edge → no size
d_stop  = |entry − stop|/entry + fee_rt + spread/2
N       = min(E·r_eff/d_stop, E×notional_cap, settled_cash, heat_room/d_stop)
```
"Reputation > 1 can lift a trade toward the cap, never past it." (~90 property-test sweeps prove caps hold.)

**Fail-closed REDUCE_ONLY triggers** (sweep 2-a §4): margin without cash-only config; unknown broker order;
orphan position the bot didn't open ("Entries blocked until it's gone"); account far bigger than doctrine start;
free-tier budget ≥90%; platform limit errors; RED breaker; operator pause/flatten. Corrupt equity data reads
ORANGE, never GREEN (src/risk/CircuitBreakerLadder.ts:36-41).

**Sanity vetoes** (ADR-067, src/risk/sanity.ts): stablecoin depeg >50 bps; Alpaca-vs-Coinbase gap >1%; Nasdaq
trade halts.

## 5. Accounts, autonomy dial, graduation

- Accounts: PAPER ($54) + LIVE ($54) in one brain; LAB is a third, separate brain (LabCortexDO + D1 cortex-lab)
  forward-testing strategies so "PAPER's record (and its graduation clock) only ever contains strategies that
  earned their place" (src/cortex/lab.ts:5-8)
- Autonomy dial (Brain.ts:199-200): PAPER {0, 2, 4} / LIVE {0, 3, 4} — 0 shadow; PAPER trades at 2; LIVE at 3;
  4 colleague mode. **Stop 1 (approve-each-trade) deliberately does not exist** (ADR-024)
- LIVE graduation gate (docs/RISK_DOCTRINE.md:91-104; research/cortex_research/governor/run.py:275-306): phases
  0–6 complete; ≥30 consecutive days fully autonomous PAPER; ≥25 closed trades; positive post-fee expectancy;
  PF > 1.2; zero rail violations; heartbeat ≥99.9%; calibrated Brier < 0.25; every RED self-recovered + reviewed;
  live kill drill; then RATIFY. The Governor tracks this gate from data and it is displayed in the app
  ("Real-money gate" list, web/src/pages.tsx:389-449)
- ADR-083: the app can connect a live account; it joins at Stop 0 and "the user may ratify whenever they choose,
  with the paper gate shown as a warning" — everything else (cash-only, sizer, breakers, kill switch, licence
  check) still binds LIVE
- ADR-081: accounts of any size work — equity is measured from where the account started; margin accounts stay
  reduce-only unless capped 1x cash-only; fresh start when the broker account changes

## 6. Memory & learning loops (what actually adapts)

- **Scar tissue** (src/risk/scar.ts): operator-merged YAML rules, each citing ≥3 contract-id postmortems;
  hard_filter rules compile to Tier 0 vetoes checked before every entry AND before convening the court; "rules
  only ever remove trades, never add or enlarge them"
- **Reputation (W_rep)**: per-news-source weight 0.5–1.2 applied to sizing after ≥20 graded signals
- **Beliefs**: Governor-authored statements with confidence decaying by half-life (60-day default); top-3 with
  confidence ≥ 0.35 handed to the court as data
- **Calibration**: isotonic maps in config/calibration.json "produced only by Governor pull requests";
  until 50 outcomes, shrink toward 0.5
- **Governor** (governor.yml daily/weekly; src/cortex/Brain.ts:4886-4985): grades every rejected candidate at
  24 h/72 h/7 d horizons; postmortems classified GOOD_PROCESS_GOOD_OUTCOME / GOOD_PROCESS_BAD_LUCK /
  BAD_PROCESS_BAILOUT_LUCK / BAD_PROCESS_LOSS; weekly skill fitness with BH-FDR; opens PRs for doctrine/scar/
  calibration — "the Governor only proposes; the operator merges"
- **Exit intelligence** (ADR-059, src/portfolio/exits.ts): breakeven ratchet at +1R, chandelier trail, hold-or-
  harvest, re-underwriting tripwires on new headlines, position rotation; MFE/MAE excursions journaled
- **Model drift canary** (ADR-070, weekly): same golden prompt to every court model; scoreboard with
  schema-pass rate + latency at /api/models
## 7. UI surfaces inventory

### 7.1 Web terminal (the operator cockpit) — `web/`
- Stack: **React 19 + Vite 6 + TypeScript**, no router/state lib (plain hooks); fonts self-hosted
  `@fontsource/b612` + `b612-mono`; only runtime dep `qrcode-generator` (web/src/styles.css:1-4; web/src/qr.tsx:1)
- Build: `pnpm web:build` → `public/`, served by the cortex Worker as static assets (free, outside the 3 MB
  worker bundle); strict CSP (`web/public/_headers`): default-src 'none', self-hosted fonts/scripts only,
  frame-ancestors 'none', X-Frame-Options DENY
- Layout (ADR-036, docs/DECISIONS.md:330-347): Airbus-ECAM dark cockpit — glareshield strip (MASTER WARN /
  MASTER CAUT annunciators, brand "CORTEX-54 OPERATOR TERMINAL", UTC clock, PULSE age, JOURNAL seq), upper
  display (per-account equity readouts, drawdown/heat/free-tier dials, trend sparkline vs BTC & SPY buy-and-hold,
  memo/alert column — "NOTHING LIT · LEAVE IT ALONE" when clean), lower display with system pages, ECP key row,
  overhead panel of lit pushbuttons "dark in their normal state"
- Pages (web/src/App.tsx:24-35): ACCT, FEED ("EVERYTHING THE ROBOT SAYS"), ASK ("ASK THE ROBOT"), FUNNEL ("COURT
  AND REJECTIONS"), MEM, OPT ("OPTIONS SHADOW LAB"), GOV, STS, FCST ("FORECAST · KRONOS VS THE ROBOT"), SET.
  Keyboard 1–9,0; `?` opens a 16-step spotlight guide (web/src/guide.tsx)
- TODAY strip (ADR-073, web/src/today.tsx:21-82): one plain sentence — "The robot has $55.87 (+$0.87 since it
  started with $54.00). It holds SOL/USD, NVDA. Latest: … Needs a look: …"
- Guarded controls (web/src/overhead.tsx): FLATTEN under a red flip-cover guard (8 s); autonomy rotary with SET
  confirm; LIVE RATIFY typed, double-confirmed 10 min–24 h later on a fresh sign-in; court convene panel warns
  "restarts the 30-day autonomous clock… The safest input is usually none."
- Onboarding (ADR-073, web/src/onboarding.tsx): 5-step wizard; "Just look around in demo mode first" skip path
- API (src/web/api.ts:111-310): /api/state, /api/feed, /api/settings, /api/forecast, /api/equity, /api/memory,
  /api/court, /api/models, /api/rejections, /api/options + command routes; single-use login link; CSRF header;
  polling 15 s (state) / 20–300 s (rest), visible-tab only

### 7.2 Design tokens (the existing brand vocabulary)
From web/src/styles.css:6-31:
```
--shell #15191c · --shell-2 #1b2024 · --bezel #23292e · --bezel-hi #2f363c
--glass #060809 · --glass-2 #0b0e10 · --rule #1e2428
--engrave #7d878f · --dim #5b656c · --white #e9eef1
--green #3ddc84 · --amber #f5a524 · --red #ff4438 · --cyan #38c8f0 · --magenta #e464dc
--amber-glass #2a1d05 · --red-glass #2c0b08
--ui "B612" · --num "B612 Mono" (the Airbus cockpit faces, OFL-licensed)
--ease cubic-bezier(0.16,1,0.3,1)
```
- Colour semantics (a fixed vocabulary): **green = normal/active · amber = caution · red = warning ·
  cyan = actionable · white = labels · magenta = targets**. PRODUCT.md:58-59 records the palette commitment:
  emerald gains, crimson risk, cyan model telemetry, amber/orange warning bands. Operator voice: "terse,
  factual, no hype" (PRODUCT.md:59)
- Typography: B612 (400/700) + B612 Mono; 11–15px UI sizes, 46px hero numerals, tabular-nums, letter-spacing
  0.08–0.18em on uppercase labels
- Shape: bezel radii 2–10px, engraved-label + lamp metaphor, inset highlights, radial glass gradient;
  `prefers-reduced-motion` kills all animation; focus-visible 2px cyan
- PRODUCT.md accessibility commitments: color never the only signal (labels/icons accompany band colors);
  keyboard reachable; respects reduced motion; dark UI for long sessions

### 7.3 Desktop app — `desktop/`
- **Tauri v2** shell (ADR-066): bundles `dist/cortexd` (esbuild single-file brain + web build + migrations +
  research Python package) + official **Node 24 sidecar** (SHASUMS256-verified download —
  scripts/fetch-node-runtime.ts:34-43)
- Window 1320×860; hides-to-tray (trading continues); tray shows "CORTEX-54 ● · $55.87 · 2 position(s) · pulse
  37s" + health line + Kill switch (stop new entries) / Re-arm / Update items (desktop/src-tauri/src/lib.rs:186-250)
- First launch: auto `setup --mode demo --yes` → the app shows a real live trading cockpit before any signup
  (lib.rs:165-168)
- Updater: tauri-plugin-updater, minisign-signed `latest.json` from GitHub releases; "nothing installs without a
  click"; splash: "Starting CORTEX-54 — The brain is waking up on this computer… Nothing trades until the brain
  has checked the account, the regime and its own health." (desktop/ui/index.html)
- Platforms (release.yml:80-85): macOS arm64/x86_64, Linux x86_64/arm64, Windows x86_64 (msi/NSIS/MSIX);
  macOS ad-hoc sealed signature (ADR-080), notarization wired but conditional on Apple secrets existing — **do
  not claim "notarized" unconditionally** (release.yml:54-57); Windows MSIX unsigned by design ("SmartScreen
  asks once", docs/DISTRIBUTION.md:52-54)
- Navigation guard (ADR-082): outside links open in the system browser (unit-tested against a spoofed local URL)

### 7.4 Hub — `hub/` (ADR-068)
- Pure JSON API on Workers + D1, CORS *, **no web UI at all** (hub/src/handler.ts:11-21): POST /v1/feed (signed
  hash-linked journal batches; stale/rewritten/backfilled rejected), GET /v1/agents/:id, /v1/leaderboard (≥5
  closed trades), /v1/packs (signed memory/strategy packs)
- "No broker keys, no account numbers, no trading anywhere in this database"; append-only enforced by DB
  triggers; leaderboard honesty note: "proves a record wasn't rewritten — not that broker fills were real"
- Status: "built and tested in-process; **not deployed** (needs a D1 id and a domain)" (docs/DISTRIBUTION.md:38-39)

### 7.5 Discord (optional add-on since ADR-071)
- 8 channels auto-provisioned + private category (command_center/briefs/court/executions/world_intel/governor/
  alarms/terminal); 11 slash commands (status/pause/resume/dial/flatten/unlock/court/why/roast/book/universe/
  terminal); Ed25519-verified interactions + 5-min replay window; operator-ID authorization on every mutation
- HUD card edited ≤1/5 s; courtroom card for every session; six-part court transcript (ADR-044)
- Every web control has a Discord twin — shared command runner with a parity test (test/web.test.ts:113)

### 7.6 Widgets — `tools/` (ADR-062)
- macOS SwiftBar menu-bar plugin (tools/widgets/swiftbar/cortex.30s.sh) + Windows tray (CortexTray.ps1); both
  **read-only** ("none can trade, pause or flatten") and **both executed by CI** (test/monitoring.test.ts:89);
  plus ntfy phone pushes and a read-only `/pill` endpoint

## 8. ECAM — what it actually is (walled off)

**In this repo, "ECAM" is not a separate product.** It is the name for two things:
1. **A design direction**: the web terminal deliberately looks like an Airbus ECAM dark cockpit — chosen by the
   operator over an alternative "signal-box" direction (ADR-036, docs/DECISIONS.md:335). "Nothing is lit when
   CORTEX is normal; MASTER WARN/CAUT annunciators light only for real conditions." B612/B612 Mono are literally
   "the Airbus cockpit faces".
2. **A pure module**: `web/src/ecam.ts` — turns brain state into warnings (red) / cautions (amber) / memos
   (green) with priority ordering and auto page-call; unit-tested in test/ecam.test.ts ("stays dark when
   normal… warnings for RED + lost pulse…").

The `.impeccable/surfaces/web-index-html.md` design contract records the same thesis ("dark cockpit; light =
attention; fixed colour vocabulary; refuses neon-dashboard default") and notes the cockpit was "candidate 1 of
my grounded list (operator's pick over the assigned signal box)".

**Implication for the landing page** (per the client): the operator panel / cockpit is a product surface that
exists and can be shown, referenced, screenshotted, embedded or demoed where that helps sell Cortex — but the
landing page itself must not become a copy or extension of the ECAM cockpit look. It needs its own design
direction, arrived at through its own ideation. Reusable *principles* (without the Airbus conceit): the fixed
semantic colour mapping, cyan-only accent discipline, "dark until it matters", honest empty states, amber
disclosure banners, guarded destructive actions. The panel's own surface contract lives in
`.impeccable/surfaces/` as a format example.

## 9. Platform & tooling facts

- **Package manager**: pnpm@10.18.0 (`packageManager` field); Node ≥22 (24 for local runtime)
- **Monorepo shape**: single package.json (no pnpm workspaces); web/ has its own tsconfig + vite configs;
  research/ is uv-managed Python
- **Language/runtime**: TypeScript 5.9 strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes), ESM;
  Python ≥3.11 (research desk)
- **Lint/format**: Biome (`pnpm lint` / `pnpm format`); noExplicitAny: error; 2-space/110 cols
- **Test**: Vitest 4 in Node (`pnpm test` = config:build + vitest run); fast-check property tests pinned to
  `seed: 54` (a deliberate pun); pytest for research/
- **Build gate**: `pnpm config:build` validates config/ against the constitution with zod and generates
  src/generated/config.ts with CONSTITUTION_SHA256/DOCTRINE_SHA256 — "a doctrine value looser than the
  constitution fails config:build, which fails CI, which blocks deploy" (CLAUDE.md:336)
- **Deploy**: Cloudflare-centred. `pnpm deploy:cortex` (config:build + web:build + wrangler deploy) and
  `pnpm deploy:sentinel`; D1 migrations via wrangler; CI deploys from main only when CLOUDFLARE_API_TOKEN exists
  (.github/workflows/ci.yml:60-65). **Do not assume Vercel.** 7 workflows: ci, research (9 UTC crons),
  governor, kill-switch, watchdog, canary, release
- **Hosting surfaces today**: the terminal lives on workers.dev (no custom route); the demo cockpit on GitHub
  Pages (https://x-thefox.github.io/Cortex-54/, ADR-079)
- **Desktop releases**: `gh workflow run release -f bump=minor` / auto on merges to main; changelog from git;
  updater manifest; demo cockpit zip attached to every release + deployed to Pages
- **Licence tooling**: `tsx scripts/license.ts keygen | issue` (Ed25519); pubkey baked into builds via
  CORTEX_LICENSE_PUBKEY; "no phone-home and no obfuscation: the point is a clear, honest gate… not DRM"
  (local/license.ts:7-10)
- **Docker**: node:24-bookworm-slim + uv; ships only dist/cortexd (closed-source, no TS source); port 8754;
  first boot keyless demo; HEALTHCHECK /health every 60 s. Status: "written; not run in a container yet"
  (docs/DISTRIBUTION.md:38)
- **A `.claude/launch.json`** exists with one profile "web" running `pnpm web:dev --port 5174 --strictPort`
- **Docs drift tests**: test/docs.test.ts is "brittle on purpose" — it scans CLAUDE.md, docs/ARCHITECTURE.md,
  docs/DATA_SOURCES.md, docs/DECISIONS.md for forbidden claims (e.g. "no Workflow class exists", "no
  approve-each-trade mode") and requires the ADR log to be complete. New markdown files elsewhere are not
  scanned, but the same hygiene is expected
## 10. Demo & simulation inventory (the demo-button material)

This is the richest vein for the client's one hard requirement. Four working demo layers exist:

### 10a. Static demo cockpit (shipped, public, ADR-077/079) — the obvious demo-button target
- `web/src/demo.ts` + `web/mock-api.ts` + `web/vite.demo.config.ts`: the **real cockpit panel** answering every
  `/api/*` call **in the browser** (fetch is monkey-patched; 120 ms artificial latency "feels like a network");
  nothing leaves the page; production builds tree-shake it away (demo.ts:3-7)
- Sticky amber banner: "DEMO · synthetic data · nothing here is real money or a real account" (demo.ts:30-33)
- **Scenario selection via URL query** (demo.ts:8-12): default (normal), `?alert` (PAPER breaker YELLOW +
  REDUCE_ONLY + stale regime → lit MASTER CAUT), `?empty` (day one: $54.00 exactly, everything unpopulated,
  honest copy). mock-api.ts:473-545 also has `/?live` (dev only) exercising the ratify guard
- Built by `pnpm web:demo` → `demo-dist/` with `base: "./"` (works on any static host/sub-path); deployed to
  **GitHub Pages https://x-thefox.github.io/Cortex-54/** by every release (release.yml:174-221); zip attached
- **Embedding caveat**: the Worker deployment's `_headers` sets `frame-ancestors 'none'` / X-Frame-Options DENY,
  but that file applies to the Worker, not necessarily to the Pages deployment — verify live before iframing;
  otherwise link out (`…/?alert` / `?empty`) or vendor `demo-dist/` into the landing build
- mock fixtures are rich: equity curve $54 → $55.87, 2 positions (SOL/USD broker stop, NVDA synthetic stop),
  court sessions with full bull/bear prose + probability bars, 5 rejections with stage tones, memory
  (SCAR-001, reputation bars, decaying beliefs), options shadow rows, Kronos fan chart for any symbol, model
  scoreboard, feed cards. Every mutation answers "(demo) Nothing is saved here…" — safe to click everything

### 10b. Keyless local demo (SimBroker) — "download → instant demo" story
- `local/simbroker.ts` (ADR-064): full BrokerApi against **live public crypto quotes** (Alpaca crypto quotes
  need no key — CLAUDE.md:176); fills marketable limits at the touch, stops trigger on bid, rejects oversells;
  book starts at **$54** and persists in local SQLite so the demo survives restarts
- `pnpm demo` → throwaway temp home on port 8755 (`local/cli.ts:391-397`); desktop first launch does the same
  automatically; onboarding offers "Demo — No accounts. A simulated $54 on live crypto prices. Nothing to set
  up." (settings.tsx:247-252)
- This is the product's own funnel: every visitor who installs lands in a working cockpit with zero keys

### 10c. The test/sim seam (powerful option for a *live* landing demo)
- `Brain` takes injected clock/brokers/sql/notifier (dependency-injection seam, ADR-019). A headless
  `Brain + FakeBroker + memorySql` loop (as in test/brain.test.ts) could stream real `status()` + journal events
  to the UI for a genuine live-replay demo — the tests already drive: breakout → contract → passive entry →
  fill → broker stop → target exit → breaker trips → kill flag
- `test/sim/FakeBroker.ts` (293 L): limit/stop_limit/stop/ioc semantics, duplicate client_order_id → 422,
  held-quantity accounting, fault injection. Chaos suite runs **300 pulses × 4 seeds** with random 5xx/lost
  responses and still asserts state agreement + chain verification (test/chaos.test.ts)
- Caveat: FakeBroker "is not a matching engine" (FakeBroker.ts:18-22) — say "simulated", never "backtested
  matching engine"

### 10d. Court smoke (not a demo, but a content source)
- `pnpm court:smoke BTC/USD ["headline"]` runs a REAL bull/bear/Clef hearing on live evidence and never trades;
  the transcript cards (cards.ts:572-688) are excellent authentic copy material for explaining the court

## 11. Commercial story & distribution

- **"We ship software, the customer runs it."** We host exactly one service — the hub — and it never touches
  broker keys or money (docs/DISTRIBUTION.md:2-4). Why not SaaS: holding broker keys is "liability, security
  burden, and in many places regulated activity… also costs us money per customer" (DISTRIBUTION.md:16-19)
- **Pricing: none documented anywhere.** PSS-019…028 (personas, pricing, launch video, revenue) are marked
  `[-]` "operator decisions, not code" (docs/IDEAS_WORKLOG.md:151-152). **The landing page cannot show prices.**
- **Licence**: offline Ed25519-checked JSON (kind `cortex-54-license`, plan `standard`, expires_at null =
  perpetual); fail-safe degradation: without a valid licence "demo mode always works and paper mode keeps
  running but blocks new entries — open positions keep their stops" (local/license.ts:12-16)
- **Moat honesty**: "the real moat is the hub, the community, the steady stream of updates and the research
  quality, not secrecy" (docs/DISTRIBUTION.md:23-24); obfuscation rejected (IDEAS_WORKLOG.md:503-504)
- **Trust promises**: "keys never leave your machine" (IDEAS_WORKLOG.md:398-401); the product never enters
  payment details for the user; one brain per Alpaca account; "You run it; we never see it"
  (docs/SELF_HOSTING.md:3)
- **Persona signals** (from SETUP_WITH_AN_AGENT.md, onboarding copy, IDEAS_WORKLOG): technically curious
  individuals — AI-agent enthusiasts, quant hobbyists, tinkerers with a NAS/home server; comfortable with
  Alpaca paper accounts and free LLM keys; want autonomy *and* governance; allergic to cloud lock-in and to
  hype. Setup must be "as untechnical as possible without losing any advanced feature" (IDEAS_WORKLOG.md:336-337)
- **What's NOT shipped yet** (never claim): Docker image run in a container; hub deployed; notarization done;
  Windows code-signing cert; second broker adapter; native mobile apps; marketplace/payments (docs/FUTURE_PLANS.md
  + IDEAS_WORKLOG.md:446-471, 501-502 + DISTRIBUTION.md:38-54)

## 12. Tests as proof (claim anchors)

- **32 vitest files, ~339 `it()` cases (~355 after .each), 8,990 LOC of TS tests for ~17.3k LOC of src — plus
  10 Python pytest files.** All deterministic (fast-check `seed: 54`), no network, no real brokers
- Test-backed claims safe to make, each with an anchor:
  - "models never size" — contract JSON cannot contain qty/notional/size keys (test/court.test.ts:419)
  - "no contract, no order" — invariant monitor + broker-conformance idempotency (test/brain.test.ts:284)
  - every position has an exit; stop never moved below initial — chaos suite (test/chaos.test.ts:221)
  - breaker ladder monotone + hysteresis + fail-closed corrupt data (test/properties.test.ts:93, 213;
    test/risk.test.ts:154)
  - journal hash chain: flipping any one byte breaks verification (test/properties.test.ts:117); real-D1
    append-only trigger throws (test/brain.test.ts:339)
  - kill switch: garbage payload = killed; unknown KV state blocks entries; LIVE-only kill leaves PAPER
    (test/brain.test.ts:227/260/246, test/local.test.ts:263)
  - Discord ↔ web command parity (test/web.test.ts:113); prompt-injection regression suite
    (test/court.test.ts:395); broker conformance suite run against every adapter (test/broker-conformance.test.ts)
  - fees: paper accounts charge themselves modeled fees + slippage (test/risk.test.ts:122-138)
  - licences: tampered/foreign/expired refused; paper without licence holds entries (test/product.test.ts)
  - widgets are executed by CI (test/monitoring.test.ts:89); docs can't claim non-existent features
    (test/docs.test.ts)
- Honest caveats: tests run in Node against SQLite stand-ins with the real migrations (not the Cloudflare
  runtime); FakeBroker is a simulator, not a matching engine

## 13. Constraints & conventions for any new surface (from CLAUDE.md etc.)

- TypeScript strict, ESM, no `any` at module boundaries; validate external payloads with zod
- Money in integer cents; epoch-ms UTC internally; ET display only; conservative rounding
- Keep bundles small (worker budget <2 MB compressed; web JS was ~80 KB gzip — ADR-036)
- Self-hosted fonts and scripts only (strict CSP); the CSP in web/public/_headers is the reference
- Accessibility: reduced motion respected, color never the only signal, keyboard reachable (PRODUCT.md:73-77)
- Voice: terse, factual, no hype (PRODUCT.md:59); "Every number traceable: show where a value comes from
  (source, time, model)" (PRODUCT.md:71); empty states must say why (PRODUCT.md:64)
- Commits: operator's git identity; **no AI attribution of any kind** (CLAUDE.md:372-375)
- `pnpm typecheck && pnpm lint && pnpm test` must stay green; biome formats everything
- The existing web terminal must keep working: web/ builds into public/ for the Worker; the demo build is
  separate (vite.demo.config.ts); a landing page should not regress either
- Licences of anything new must allow commercial use; NOTICE.md records the porting discipline (MIT with
  attribution; no-license projects = ideas only, never copy code)

## 14. Copy-safe claims vs forbidden claims

**Copy-safe (with anchors in §2/§12):** $0/month infrastructure on free tiers (itemised in
docs/FREE_TIER_BUDGET.md); $54 paper + $54 live in lockstep; 4-tier funnel with per-tier budgets; 8-rule
constitution no model can override; deterministic risk engine (worked example: max loss ≈ $0.54 on $54); broker-
side + synthetic stops on every position; independent sentinel kill-switch reachable even via GitHub;
hash-chained append-only journal with hand-rolled synchronous SHA-256; two RATIFYs for real money; no
approve-each-trade mode; ~355 test cases incl. property tests + chaos suite + injection suite; cross-family
bear or no trade; expert panel + judge; calibration shrink until 50 outcomes; LAB forward-testing brain;
model pool with BYOK (50 endpoints × 50 models, Ollama/LM Studio presets); desktop app on 5 platform targets +
tray + signed auto-updates; offline licence with fail-safe degradation; signed public track records on the hub;
RSI(2) backtest PASS stats (104 trades / 78% win / +0.27R / PF 2.51, 3 years, fees included — cite as
repo-internal research, ADR-046); first fills/exits dates; "the robot does not forecast prices"; "Hearings never
make a trade bigger"; "a backtest that agrees with the literature is still a backtest".

**Forbidden / must not claim:** any returns/profit promise or extrapolated performance; invented metrics,
customers, testimonials; "notarized" (conditional on secrets); Windows code-signing; Docker image shipped as
running; hub deployed; mobile apps; marketplace/pricing (none documented); SaaS hosting ("we ship software");
"backtested matching engine"; anything in docs/FUTURE_PLANS.md (calibration per role, conformal abstention,
Dawid-Skene, meta-labeling, paper↔live divergence breaker input, etc. — all unbuilt); "approve trades" anywhere
(it does not exist); implying the $54 LIVE account is actively trading (it is dormant until graduation + RATIFY);
any claim that Cortex gives financial advice.

## 15. Disclaimers

- The repo's only financial disclaimer: "This is an experiment with a very small amount of real money. Nothing
  here is financial advice." (README.md:25)
- In-app plain-English framing: "CORTEX-54 is a robot that buys and sells on its own, starting with $54. Right
  now it uses a practice account ("paper trading"): the money is pretend, the prices are real."
  (web/src/guide.tsx:23)
- Demo banner: "DEMO · synthetic data · nothing here is real money or a real account" (web/src/demo.ts:30-33)
- **Gap**: docs/ contains no investment disclaimer suitable for a commercial product; the landing page will need
  its own honest, lawyer-grade disclaimer (trading risk, no advice, no guarantee, paper vs live distinction).
  Reuse the repo's *framing* (experiment, tiny real money, pretend money real prices), not its README wording,
  and never bury it

## 16. File index (one line per file)

### Root
`CLAUDE.md` operating manual / the law (11 sections: product, constitution, architecture, verified facts, spec
errata, $54 doctrine, layout, commands, conventions, workflow rules, status log) · `README.md` short pitch +
status · `PRODUCT.md` product schema (platform, users, purpose, positioning, principles, brand, a11y) ·
`NOTICE.md` MIT porting attribution (tradermonty, staskh, Kronos pinned, qrcode-generator) · `package.json`
scripts/deps · `pnpm-lock.yaml` · `wrangler.jsonc` brain worker config · `Dockerfile` headless image ·
`biome.json` · `tsconfig.json` / `tsconfig.node.json` · `vitest.config.ts` · `.dev.vars.example` every secret ·
`.gitignore` / `.dockerignore` · `.claude/launch.json` web dev server profile (port 5174) ·
`.impeccable/surfaces/web-index-html.md` design-QA surface contract for the terminal (format example)

### config/ (validated at build; constitution is operator-git-only)
`constitution.json` 8 untouchables + hard limits + allowed/forbidden · `doctrine.yaml` all tunables (rungs,
breakers, sizing, fees, funnel, budgets, LLM routing, regime gates, exits, universe, watchlists, strategies) ·
`skills-index.yaml` 443-line skill registry (~40 skills, 6 families, 19 cut with reasons) ·
`calibration.json` isotonic maps (currently empty) · `scar-tissue.yaml` reflective rules (currently empty)

### src/ (the brain — 17,335 LOC)
`index.ts` stateless edge router (≤10 ms): /health, HMAC /ingest/batch, Discord interactions, /pill ·
`env.ts` typed bindings · `cortex/AgentCortexDO.ts` DO host, self-arming alarm heart · `cortex/Brain.ts` (6,362 L)
ALL trading logic: pulse, reconcile, fills, stops, exits, breakers, funnel T0–T3, court, ingest, routing, dial/
kill/unlock/flatten, invariants · `cortex/cards.ts` all Discord/app cards + terminal lines ·
`cortex/hot-schema.ts` DO SQLite v9, 25 tables · `cortex/dispatch.ts` 11 cron slots → GitHub workflows ·
`cortex/lab.ts` LAB doctrine view · `cortex/queue.ts` desktop-runner job queue · `cortex/store.ts` SqlLike ·
`contracts/decision-contract.ts` keystone zod schema · `contracts/doctrine.ts` doctrine schema + ~20
CI-checked violation rules · `contracts/constitution.ts` · `contracts/calibration.ts` · `contracts/batch.ts`
HMAC research batches · `risk/PositionSizer.ts` · `risk/PreTradeValidator.ts` (~25 checks) ·
`risk/CircuitBreakerLadder.ts` · `risk/fees.ts` · `risk/rungs.ts` R1–R5 · `risk/scar.ts` ·
`risk/correlation.ts` · `risk/sanity.ts` · `broker/AlpacaClient.ts` · `broker/types.ts` ·
`broker/registry.ts` verified + rejected venues with reasons · `budget/FreeTierBudget.ts` 12 resources ·
`journal/Journal.ts` hash chain + outbox + quarantine · `strategy/` CryptoBreakoutBaseline, BearAndBounce,
Classics, KronosForecast, indicators, params (zod-checked at build) · `discord/` notifier, commands, setup,
verify (Ed25519), interactions · `lib/` ids, num, sha256 (sync, NIST-tested), hmac, time · `clef/` ClefClient,
triage, tier2, clairic (grounding check), portable shims · `court/` court.ts, prompts.ts (versioned), evidence.ts,
llm.ts (router), anthropic.ts, models.ts, pool.ts, providers.ts, canary.ts · `notify/` inbox.ts, push.ts (ntfy) ·
`universe/` Universe, prefilter (24 regexes), screen (fail-closed) · `portfolio/` exits, book, lateness ·
`hub/` client.ts, protocol.ts (Ed25519 identity) · `web/` api.ts, commands.ts (shared runner), session.ts, pill.ts

### web/ (operator terminal, React 19 + Vite 6)
`index.html` · `src/main.tsx` (demo import + SW) · `src/App.tsx` cockpit layout + pages + ECAM acks ·
`src/api.ts` types + polling · `src/ecam.ts` warnings/cautions/memos (pure) · `src/today.tsx` plain-sentence
strip · `src/overhead.tsx` guarded controls + RATIFY · `src/instruments.tsx` dials/trend SVG · `src/pages.tsx`
ACCT/FUNNEL/MEM/OPT/GOV/STS · `src/forecast.tsx` Kronos fan chart · `src/feed.tsx` channels + embed cards ·
`src/ask.tsx` WHY/COURT/ROAST/BOOK · `src/settings.tsx` (1,640 L, all settings) · `src/onboarding.tsx` 5-step
wizard · `src/guide.tsx` 16-step tour · `src/qr.tsx` SVG QR · `src/demo.ts` fetch patch + banner ·
`src/styles.css` (1,917 L, all tokens) · `mock-api.ts` synthetic API + scenarios · `vite.config.ts` prod ·
`vite.demo.config.ts` demo build · `public/_headers` strict CSP

### desktop/ (Tauri v2)
`src-tauri/tauri.conf.json` window/bundle/updater · `src-tauri/src/main.rs` + `lib.rs` shell (daemon spawn,
tray, updater, nav guard) · `src-tauri/Cargo.toml` · `capabilities/default.json` · `entitlements.plist` ·
`ui/index.html` splash · `icons/` platform sets

### local/ (cortexd local mode)
`cli.ts` the `cortex` CLI · `runtime.ts` server (SimBroker wiring, /health, CSP) · `simbroker.ts` keyless
sandbox on live crypto quotes · `config.ts` · `settings.ts` · `agent-prompt.ts` setup prompt for AI agents ·
`jobs.ts` uv research jobs · `service.ts` launchd/systemd/schtasks · `license.ts` offline Ed25519 ·
`health.ts` plain-word checks · `keychain.ts` OS keychain · `store.ts` SQLite · `backup.ts` encrypted backups ·
`memory.ts` signed packs · `deploy.ts` own-Cloudflare deploy · `runner.ts` cloud job runner

### hub/ + workers/sentinel/
`hub/src/index.ts` + `handler.ts` JSON API · `hub/wrangler.jsonc` · `hub/migrations/0001_hub.sql` append-only ·
`workers/sentinel/wrangler.jsonc` per-minute cron, thresholds 8 min / 6% / 60 min ·
`workers/sentinel/src/index.ts` watchdog + killAll · `workers/sentinel/src/verify.ts` vendored Ed25519
("must not import from the brain") · `workers/sentinel/src/commands.ts` /kill /rearm /sentinel

### docs/ (14 files)
`ARCHITECTURE.md` authoritative system map + pulse stages · `RISK_DOCTRINE.md` exact $54 math + worked example ·
`FREE_TIER_BUDGET.md` the $0.00/month itemisation · `DECISIONS.md` 83 ADRs (2026-10-22 → 10-27) ·
`ROADMAP.md` phases 0–7 + exit gates · `DISTRIBUTION.md` commercial story (no pricing) · `DATA_SOURCES.md`
every free source + blocked sources · `STRATEGY_RESEARCH.md` backtest verdicts table · `IDEAS_WORKLOG.md`
idea verdicts + direction quotes · `FUTURE_PLANS.md` the not-built list · `RUNBOOK.md` operator ops ·
`SELF_HOSTING.md` Docker/headless install · `SETUP_WITH_AN_AGENT.md` verbatim agent setup prompt ·
`SKILLS_PORTING.md` why 85–91 skills were not ported

### scripts/ (12)
`build-config.ts` zod gate + sha256 stamps · `build-cortexd.ts` closed-source bundle · `changelog.ts` ·
`court-smoke.ts` real hearing, never trades · `discord-setup.ts` · `drift-canary.ts` ·
`fetch-node-runtime.ts` verified Node sidecar · `license.ts` publisher keygen/issue · `msix.ts` ·
`register-commands.ts` · `release-assets.ts` · `updater-manifest.ts`

### research/ (Python desk, uv)
`run.py` jobs crypto|equity|world|screeners|kronos|backtest|dossier, HMAC-signed ingest · `screeners.py` ·
`backtest.py` 3-year replays with costs + BH-FDR · `kronos_forecast.py` 24 sampled paths, vol-rescaled ·
`governor/` grading, calibration, LIVE gate · `options/` shadow lab (bs.py, structures.py ported MIT) ·
`deep/` web-research agent (tools.py, llm.py, agent.py, job.py) · `companions.py` Chronos-2 · `payload.py` ·
`calendar.py` · `world.py` · `hmm.py` · `tests/` 10 pytest files

### test/ (32 files, ~355 cases)
`risk.test.ts` sizer/fees/breakers/validator · `properties.test.ts` 5 fast-check properties (caps, constitution
gate, breaker monotonicity, hash chain, fail-closed) · `brain.test.ts` (2,481 L, 90 tests) full pulses ·
`court.test.ts` bull checks + injection suite · `chaos.test.ts` 300 pulses × 4 seeds ·
`broker-conformance.test.ts` every adapter · `exits.test.ts` · `universe.test.ts` · `entry-timing.test.ts` ·
`config.test.ts` shipped-config gate · `decision-contract.test.ts` · `local.test.ts` · `settings.test.ts` ·
`product.test.ts` ADR-075/076/077/083 · `hub.test.ts` · `pool.test.ts` · `strategy.test.ts` · `sanity.test.ts` ·
`web.test.ts` parity + fresh-signin guards · `discord.test.ts` · `monitoring.test.ts` (CI runs real widgets) ·
`ecam.test.ts` · `budget.test.ts` · `cloud.test.ts` · `docs.test.ts` drift guards · `dispatch.test.ts` ·
`lib.test.ts` NIST/HMAC · `canary.test.ts` · `scar.test.ts` · `time.test.ts` · `correlation.test.ts` ·
`broker.test.ts` + `sim/FakeBroker.ts`, `sim/sqlite.ts`, `helpers.ts`, `fixtures/validator.ts`

### .github/workflows/ (7)
`ci.yml` typecheck/lint/test/web:build + conditional deploy · `research.yml` 9 crons + 8 dispatch jobs ·
`governor.yml` daily + Sunday PR · `kill-switch.yml` brain-independent FLATTEN ALL · `watchdog.yml` 30-min
backup tick · `canary.yml` weekly model drift · `release.yml` 5-platform build + MSIX + demo cockpit zip +
GitHub Pages deploy + updater manifest

### tools/widgets/
`swiftbar/cortex.30s.sh` macOS menu bar · `windows/CortexTray.ps1` Windows tray · both read-only, CI-tested

### migrations/
`0001_initial_schema.sql` (14 append-only triggers) · `0002_contract_origin.sql` RULE|COURT ·
`0003_options_shadow.sql` virtual ledger

## 17. Open questions & contradictions

1. **ECAM framing.** The client brief describes ECAM as "a distinct product surface… sold as a panel." In the
   repo, ECAM is the design language + alert logic of the operator web terminal (ADR-036 + web/src/ecam.ts), not
   a separately sold product. Resolution adopted: treat the cockpit as a showcase-able product surface; wall off
   its look from the landing page. The landing agent should not manufacture an "ECAM product" that does not exist.
2. **README vs ADRs.** README.md:5 says "controlled from Discord"; ADR-071+ (docs/DECISIONS.md:927) made the app
   the dashboard and Discord optional. ADRs win. Landing copy should follow the app-first story.
3. **PRODUCT.md scope.** PRODUCT.md:16 says "One user: the operator" — written 2026-10-23, before the
   commercial pivot (2026-10-26). Its positioning section ("governance console for a self-improving trading
   organism", "rails before reasoning") remains the best brand voice, but audience assumptions are outdated.
4. **$0/month scope.** The $0 claim applies to the operator's *cloud* deployment (Workers Free) and to defaults;
   the commercial product runs on the customer's machine where "local mode has no Cloudflare limits"
   (docs/FREE_TIER_BUDGET.md:147-148) and BYOK paid models are the customer's optional choice (CLAUDE.md:25-28).
   Landing copy must scope the claim precisely.
5. **Roadmap status drift.** README says phases 0–6 all built/deployed; ROADMAP.md §Phase 3 notes read "in
   progress"; CLAUDE.md §11 (freshest) confirms code-complete on 2026-10-23. Use CLAUDE.md §11.
6. **Not-yet-live infrastructure.** Docker image written-but-never-run; hub built-but-not-deployed; notarization
   conditional; no Windows signing cert. See §11 "what's NOT shipped".
7. **Pricing does not exist** in the repo (operator decision pending). Landing page must not invent tiers.
8. **Backtest numbers are repo-internal research** (ADR-046, 2026-10-24, 3 years, fees+slippage). They are
   honest and citable *as such* — "in our own backtest lab, net of modeled costs" — never as live performance.
9. **`src/court/llm.ts:126` contains fictional future model names** (e.g. `claude-fable-5-1`) in a fallback
   regex. Never quote model names from regexes; quote them from doctrine.yaml routing chains instead.
10. **Iframe feasibility of the demo cockpit is unverified** (Worker CSP says frame-ancestors 'none'; the Pages
    deployment's headers are GitHub's). Verify live before designing an embed-dependent layout.
11. **Demo scenario URLs**: `?alert` and `?empty` work on the static Pages demo; `?live` exists only in dev
    (mock-api sets it via cookie on page load). Don't link `?live`.
12. **No SECURITY.md / issue templates / FUNDING** exist (.github has only workflows) — a landing page shouldn't
    link to community pages that don't exist.
13. **The 30-day graduation gate** means the $54 LIVE account has not traded yet (Stop 0). Any timeline or
    "it trades live today" copy would be false. The lockstep twin-account design is the honest story.
14. **Fonts**: B612/B612 Mono are SIL OFL (commercial use fine, keep attribution per licence). qrcode-generator
    is MIT. Any new library the landing page adds needs a commercial-OK licence (see §13).



## 18. The landing page (built 2026-10-27, ADR-084) — findings for later agents

- **Where:** `landing/` (vanilla TS + Vite), notes and task list in `landing/CLAUDE.md`. Build `pnpm landing:build` →
  `landing-dist/` with the demo cockpit at `landing-dist/demo/`. Deployed to GitHub Pages by `release.yml` job `pages`;
  the site root is now the landing page and the demo cockpit moved to `/demo/`.
- **Iframe question (§17.10) resolved:** the Pages deploy deletes the cockpit's `_headers`, and the landing build bundles
  the cockpit on the same origin, so the demo opens in a same-origin `<iframe>` inside a `<dialog>` (`frame-src 'self'`).
- **Reusable in the browser (verified):** `src/risk/PositionSizer.ts` (+ `src/lib/num.ts`), `src/journal/Journal.ts`
  `rowHash()` (+ `src/lib/sha256.ts`), and `src/generated/config.ts` (CONSTITUTION, DOCTRINE, SHAs) bundle cleanly
  with type-only imports. The page uses all three; numbers are printed at build time through `%%TOKEN%%`s.
- **Sizer edge behaviour seen on the page (real code):** conviction 3 → lifted to the $10 venue minimum ($10.05);
  conviction 1 → "size $1.75 below the $10 venue minimum (needs 5.8× the risk size)"; p = 0.50 or ORANGE → "effective
  risk is zero"; conviction 10 / p 0.80 / bear 0 / stop 1.5% → $18.90, bound by concentration.
- **Counts verified 2026-10-27:** 359 vitest cases pass (page says "350+"); 14 `CREATE TRIGGER`s in
  `migrations/0001_initial_schema.sql`; latest release v0.1.5 with dmg/AppImage/deb/rpm/exe/msi/msix assets.
- **Journal kinds used in the synthetic chain** (all real): COURT, CONTRACT, FILL, STOP_BROKER, STOP_MOVE, DAY_ROLL.
- **Lint baseline:** `pnpm lint` already failed on main before the landing work (unused imports in
  `src/cortex/cards.ts`, `local/cli.ts`, `local/backup.ts`, `src/cortex/Brain.ts`; three specificity warnings-as-errors in
  `web/src/styles.css`). The landing files lint clean.
- **Claims guard:** `test/landing.test.ts` scans the page copy for forbidden claims (§14).
- **Third-party additions** (NOTICE.md): gsap 3.15 (GSAP Standard no-charge licence; commercial sites allowed, the only
  restriction is building a Webflow-competing visual animation tool), lenis 1.3 (MIT), Newsreader + IBM Plex (OFL).
  React Bits (MIT + Commons Clause) was researched and not used. Research notes: `landing/research/REFERENCES.md`.
- **Operator direction 2026-10-27 (after the first build):** (1) the product handles accounts of any size — "$10 to
  billions"; $54 is only the reference account. Code basis: rungs R1–R5 with R5 `equity_max: null`
  (config/doctrine.yaml), ADR-081 (any size measured from where it started). The page says "ten dollars or ten figures"
  and scopes "no ceiling" to the software (liquidity limits huge sizes). Real-code facts: $10 crypto → no trade
  (35% cap = $3.50 < $10 minimum order); $10 stocks → $2.49 position; $1B → R5, $200,000,000 position cap.
  (2) CORTEX-54 is sold closed-source: no GitHub/release/source links anywhere on the page; buying goes to a hosted
  checkout (Whop, link pending) set in `landing/checkout.ts`. Note the repository itself is public today (free
  Actions), which the page cannot change.

