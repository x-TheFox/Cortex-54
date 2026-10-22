/**
 * Durable Object SQLite hot state (docs/ARCHITECTURE.md §6). Applied idempotently on construction.
 * Small, transactional, current-state only. History goes to D1.
 * Bump HOT_SCHEMA_VERSION and append statements; never edit applied ones.
 */
export const HOT_SCHEMA_VERSION = 1;

export const HOT_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounts (
     account TEXT PRIMARY KEY CHECK (account IN ('PAPER','LIVE')),
     equity_cents INTEGER, hwm_cents INTEGER, day_start_equity_cents INTEGER,
     settled_cash_cents INTEGER, rung TEXT NOT NULL DEFAULT 'R1', autonomy_stop INTEGER NOT NULL,
     breaker TEXT NOT NULL DEFAULT 'GREEN', mode TEXT NOT NULL DEFAULT 'NORMAL',
     reconciled_at INTEGER, killed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS positions (
     account TEXT NOT NULL, symbol TEXT NOT NULL, arena TEXT NOT NULL, contract_id TEXT NOT NULL,
     qty TEXT NOT NULL, avg_entry TEXT NOT NULL, stop_price TEXT NOT NULL, targets_json TEXT NOT NULL,
     broker_stop_order_id TEXT, opened_at INTEGER NOT NULL, max_hold_until INTEGER NOT NULL,
     PRIMARY KEY (account, symbol))`,
  `CREATE TABLE IF NOT EXISTS lots (
     id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, symbol TEXT NOT NULL, qty TEXT NOT NULL,
     cost_cents INTEGER NOT NULL, funded_by TEXT NOT NULL CHECK (funded_by IN ('SETTLED','UNSETTLED')),
     funds_settle_at INTEGER, bought_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (
     client_order_id TEXT PRIMARY KEY, account TEXT NOT NULL, contract_id TEXT NOT NULL,
     broker_order_id TEXT, state TEXT NOT NULL, side TEXT NOT NULL, symbol TEXT NOT NULL,
     order_type TEXT NOT NULL, qty TEXT, notional_cents INTEGER, limit_price TEXT, stop_price TEXT,
     filled_qty TEXT NOT NULL DEFAULT '0', pulses_unfilled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS risk_reservations (
     contract_id TEXT NOT NULL, account TEXT NOT NULL, risk_cents INTEGER NOT NULL,
     notional_cents INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (contract_id, account))`,
  `CREATE TABLE IF NOT EXISTS regime_state (arena TEXT PRIMARY KEY, posture TEXT NOT NULL,
     score REAL, ceiling REAL, payload_json TEXT NOT NULL, as_of INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS scar_rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, rule_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budget_counters (day TEXT NOT NULL, resource TEXT NOT NULL, used REAL NOT NULL,
     PRIMARY KEY (day, resource))`,
  `CREATE TABLE IF NOT EXISTS pending_approvals (contract_id TEXT PRIMARY KEY, account TEXT NOT NULL,
     discord_message_id TEXT, expires_at INTEGER NOT NULL, decision TEXT)`,
  `CREATE TABLE IF NOT EXISTS triage_queue (candidate_id TEXT PRIMARY KEY, tier INTEGER NOT NULL,
     symbol TEXT NOT NULL, payload_json TEXT NOT NULL, enqueued_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS journal_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL,
     row_sha256 TEXT NOT NULL)`,
];
