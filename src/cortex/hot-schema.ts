/**
 * Durable Object SQLite hot state (docs/ARCHITECTURE.md §6). Applied idempotently on construction.
 * Small, transactional, current-state only. History goes to D1 via the outbox.
 * Once deployed: bump HOT_SCHEMA_VERSION and append statements; never edit applied ones.
 */
export const HOT_SCHEMA_VERSION = 3;

export const HOT_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,

  // One row per Alpaca account. Equity in cents. `mode` is the operator mode (NORMAL | PAUSED | REDUCE_ONLY).
  `CREATE TABLE IF NOT EXISTS accounts (
     account TEXT PRIMARY KEY CHECK (account IN ('PAPER','LIVE')),
     broker_equity_cents INTEGER, modeled_cost_cents INTEGER NOT NULL DEFAULT 0,
     hwm_cents INTEGER, day_start_equity_cents INTEGER, cash_cents INTEGER, buying_power_cents INTEGER,
     rung TEXT NOT NULL DEFAULT 'R1', autonomy_stop INTEGER NOT NULL,
     breaker TEXT NOT NULL DEFAULT 'GREEN', locked INTEGER NOT NULL DEFAULT 0,
     mode TEXT NOT NULL DEFAULT 'NORMAL', mode_reason TEXT,
     reconciled_at INTEGER, last_error TEXT, day TEXT, orders_today INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS positions (
     account TEXT NOT NULL, symbol TEXT NOT NULL, arena TEXT NOT NULL, contract_id TEXT NOT NULL,
     qty TEXT NOT NULL, avg_entry TEXT NOT NULL, stop_price TEXT NOT NULL, target_price TEXT NOT NULL,
     fee_rt REAL NOT NULL, opened_at INTEGER NOT NULL, max_hold_until INTEGER NOT NULL,
     broker_stop_coid TEXT, state TEXT NOT NULL DEFAULT 'OPEN', exit_reason TEXT,
     PRIMARY KEY (account, symbol))`,

  // role: ENTRY | STOP | EXIT. state mirrors Alpaca status, plus PLANNED before submit.
  `CREATE TABLE IF NOT EXISTS orders (
     client_order_id TEXT PRIMARY KEY, account TEXT NOT NULL, contract_id TEXT NOT NULL, role TEXT NOT NULL,
     attempt INTEGER NOT NULL, broker_order_id TEXT, state TEXT NOT NULL, side TEXT NOT NULL,
     symbol TEXT NOT NULL, arena TEXT NOT NULL, order_type TEXT NOT NULL, tif TEXT NOT NULL,
     qty TEXT NOT NULL, limit_price TEXT, stop_price TEXT, filled_qty TEXT NOT NULL DEFAULT '0',
     avg_fill_price TEXT, risk_cents INTEGER NOT NULL DEFAULT 0, notional_cents INTEGER NOT NULL DEFAULT 0,
     pulses_unfilled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS orders_broker ON orders(broker_order_id)`,
  `CREATE INDEX IF NOT EXISTS orders_state ON orders(account, state)`,

  // ADR-004: heat/slots reserved synchronously before any await.
  `CREATE TABLE IF NOT EXISTS risk_reservations (
     contract_id TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL, risk_cents INTEGER NOT NULL,
     notional_cents INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (contract_id, account))`,

  // Contracts the brain is still acting on (full history lives in D1).
  `CREATE TABLE IF NOT EXISTS contracts (contract_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, json TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS exits (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL,
     symbol TEXT NOT NULL, contract_id TEXT NOT NULL, reason TEXT NOT NULL, pnl_cents INTEGER, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS unsettled (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL,
     amount_cents INTEGER NOT NULL, settles_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS seen_activities (id TEXT PRIMARY KEY, account TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS asset_cache (symbol TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS regime_state (arena TEXT PRIMARY KEY, posture TEXT NOT NULL,
     score REAL, ceiling REAL, payload_json TEXT NOT NULL, as_of INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS scar_rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, rule_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budget_counters (day TEXT NOT NULL, resource TEXT NOT NULL, used REAL NOT NULL,
     PRIMARY KEY (day, resource))`,
  `CREATE TABLE IF NOT EXISTS triage_queue (candidate_id TEXT PRIMARY KEY, tier INTEGER NOT NULL,
     symbol TEXT NOT NULL, payload_json TEXT NOT NULL, enqueued_at INTEGER NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS journal_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL,
     row_sha256 TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS d1_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL,
     row_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // v2: intake dedupe across drops (news/world items are re-served by inclusive `start` cursors).
  `CREATE TABLE IF NOT EXISTS seen_items (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // v3: hot copy of Governor beliefs for Tier 2 / court memory (ADR-033)
  `CREATE TABLE IF NOT EXISTS beliefs (belief_id TEXT PRIMARY KEY, subject TEXT NOT NULL, statement TEXT NOT NULL,
     c0 REAL NOT NULL, half_life_days REAL NOT NULL, validated_at INTEGER NOT NULL, status TEXT NOT NULL)`,
];
