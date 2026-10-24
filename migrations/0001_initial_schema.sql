-- CORTEX-54 D1 schema (cortex-journal). Applied with: wrangler d1 migrations apply cortex-journal
-- Constitution U7: tables marked APPEND-ONLY reject UPDATE and DELETE via triggers.
-- Time columns are epoch milliseconds UTC. Money columns ending in _cents are integer USD cents.
-- D1 enforces foreign keys by default.

-- ---------------------------------------------------------------------------
-- Hash-chained master journal (APPEND-ONLY)
-- row_sha256 = SHA256(prev_row_sha256 || '|' || seq || '|' || ts || '|' || kind || '|' || payload_json)
-- computed by the writer (src/journal); verified daily over D1 by the Governor (ADR-030, ADR-048).
-- ---------------------------------------------------------------------------
CREATE TABLE journal (
  seq              INTEGER PRIMARY KEY,           -- strictly increasing, assigned by the DO
  ts               INTEGER NOT NULL,
  account          TEXT CHECK (account IN ('PAPER','LIVE','SYSTEM')) NOT NULL,
  kind             TEXT NOT NULL,                 -- BOOT, CONTRACT, ORDER, FILL, EXIT, BREAKER, DIAL, KILL, BUDGET, RECONCILE, NOTE ...
  ref_id           TEXT,                          -- contract_id / client_order_id / etc.
  payload_json     TEXT NOT NULL,
  prev_row_sha256  TEXT NOT NULL,
  row_sha256       TEXT NOT NULL UNIQUE
);
CREATE INDEX journal_kind_ts ON journal(kind, ts);
CREATE INDEX journal_ref ON journal(ref_id);

-- ---------------------------------------------------------------------------
-- Decision contracts (APPEND-ONLY). Status changes are new journal rows, not updates.
-- ---------------------------------------------------------------------------
CREATE TABLE decision_contracts (
  contract_id            TEXT PRIMARY KEY,        -- UUIDv7
  created_at             INTEGER NOT NULL,
  symbol                 TEXT NOT NULL,
  arena                  TEXT CHECK (arena IN ('CRYPTO','EQUITIES','OPTIONS')) NOT NULL,
  strategy_id            TEXT NOT NULL,
  thesis_summary         TEXT NOT NULL CHECK (length(thesis_summary) <= 280),
  bull_case_receipts     TEXT NOT NULL,           -- JSON array of Receipt
  bear_case_brief        TEXT NOT NULL,
  kill_criteria          TEXT NOT NULL,           -- JSON
  invalidation_criteria  TEXT NOT NULL,           -- JSON {stop_price, max_hold_hours, regime_trigger}
  entry_plan             TEXT NOT NULL,           -- JSON {zone_low, zone_high, urgency, targets[]}
  clef_probabilities     TEXT NOT NULL,           -- JSON raw + calibrated
  cost_and_fee_drag      TEXT NOT NULL,           -- JSON
  proposed_conviction    INTEGER NOT NULL CHECK (proposed_conviction BETWEEN 1 AND 10),
  models_used            TEXT NOT NULL,           -- JSON [{role, provider, model, family, prompt_version}]
  schema_version         INTEGER NOT NULL,
  contract_sha256        TEXT NOT NULL
);
CREATE INDEX contracts_symbol ON decision_contracts(symbol, created_at);

-- ---------------------------------------------------------------------------
-- Orders and fills (APPEND-ONLY event logs; current state lives in the DO)
-- ---------------------------------------------------------------------------
CREATE TABLE orders_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  account          TEXT CHECK (account IN ('PAPER','LIVE')) NOT NULL,
  contract_id      TEXT NOT NULL,
  client_order_id  TEXT NOT NULL,
  broker_order_id  TEXT,
  event            TEXT NOT NULL,                  -- PLANNED, SUBMITTED, ACK, REPEG, CANCEL, REJECT, EXPIRE, ...
  side             TEXT CHECK (side IN ('buy','sell')) NOT NULL,
  order_type       TEXT NOT NULL,
  qty              TEXT,
  notional_cents   INTEGER,
  limit_price      TEXT,
  stop_price       TEXT,
  detail_json      TEXT
);
CREATE INDEX orders_log_coid ON orders_log(client_order_id);
CREATE INDEX orders_log_contract ON orders_log(contract_id);

CREATE TABLE fills (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   INTEGER NOT NULL,
  account              TEXT CHECK (account IN ('PAPER','LIVE')) NOT NULL,
  contract_id          TEXT NOT NULL,
  client_order_id      TEXT NOT NULL,
  broker_activity_id   TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  side                 TEXT CHECK (side IN ('buy','sell')) NOT NULL,
  qty                  TEXT NOT NULL,
  price                TEXT NOT NULL,
  fee_cents            INTEGER NOT NULL DEFAULT 0,  -- broker fee (LIVE) or modeled fee (PAPER)
  modeled_slippage_bps REAL NOT NULL DEFAULT 0,      -- PAPER only
  expected_price       TEXT,                         -- price the contract planned
  UNIQUE (account, broker_activity_id)
);
CREATE INDEX fills_contract ON fills(contract_id);

-- ---------------------------------------------------------------------------
-- Rejection shadow ledger (APPEND-ONLY) + its grades (append-only too)
-- ---------------------------------------------------------------------------
CREATE TABLE rejections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  candidate_id     TEXT NOT NULL,
  contract_id      TEXT,
  symbol           TEXT NOT NULL,
  arena            TEXT NOT NULL,
  stage            TEXT NOT NULL,                  -- TIER0, TIER1, TIER2, BEAR, VALIDATOR, OPERATOR, BUDGET, REGIME
  reason_codes     TEXT NOT NULL,                  -- JSON array
  hypothetical     TEXT NOT NULL,                  -- JSON {entry, stop, targets, horizon_hours}
  source           TEXT
);
CREATE INDEX rejections_stage ON rejections(stage, ts);

CREATE TABLE rejection_grades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rejection_id     INTEGER NOT NULL REFERENCES rejections(id),
  horizon          TEXT CHECK (horizon IN ('24h','72h','7d')) NOT NULL,
  graded_at        INTEGER NOT NULL,
  outcome_r        REAL,                           -- result in R multiples, post modeled fees
  hit              TEXT CHECK (hit IN ('STOP','TARGET','NEITHER')),
  UNIQUE (rejection_id, horizon)
);

-- ---------------------------------------------------------------------------
-- Cognitive logs (prunable: retention managed by the monthly roll-up job)
-- ---------------------------------------------------------------------------
CREATE TABLE triage_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  tier             INTEGER CHECK (tier IN (1,2)) NOT NULL,
  model            TEXT NOT NULL,
  candidate_ids    TEXT NOT NULL,                  -- JSON array
  state_sha256     TEXT NOT NULL,
  answers_json     TEXT NOT NULL,
  neurons_est      REAL NOT NULL,
  latency_ms       INTEGER NOT NULL
);
CREATE INDEX triage_ts ON triage_log(ts);

CREATE TABLE llm_calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  sprint_id        TEXT,
  role             TEXT NOT NULL,                  -- BULL, BEAR, SYNTH, POSTMORTEM
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  family           TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  outcome          TEXT NOT NULL,                  -- OK, SCHEMA_FAIL, RATE_LIMITED, TIMEOUT, ERROR
  output_sha256    TEXT
);
CREATE INDEX llm_calls_ts ON llm_calls(ts);

-- ---------------------------------------------------------------------------
-- Memory and governance (mutable by design)
-- ---------------------------------------------------------------------------
CREATE TABLE beliefs (
  belief_id        TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,                  -- symbol, sector, 'CRYPTO', ...
  tags             TEXT NOT NULL,                  -- JSON array for keyword search
  statement        TEXT NOT NULL,
  c0               REAL NOT NULL,                  -- confidence at last validation
  half_life_days   REAL NOT NULL DEFAULT 60,
  validated_at     INTEGER NOT NULL,
  validations      INTEGER NOT NULL DEFAULT 1,
  status           TEXT CHECK (status IN ('ACTIVE','STRUCTURAL','ARCHIVED')) NOT NULL DEFAULT 'ACTIVE',
  evidence         TEXT NOT NULL                   -- JSON array of contract_ids / sources
);
CREATE INDEX beliefs_subject ON beliefs(subject, status);

CREATE TABLE source_reputation (
  source           TEXT PRIMARY KEY,
  signals          INTEGER NOT NULL DEFAULT 0,
  brier_30d        REAL,
  expectancy_r_30d REAL,
  weight           REAL NOT NULL DEFAULT 1.0,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE skill_fitness (
  skill_id         TEXT NOT NULL,
  week             TEXT NOT NULL,                  -- ISO week, e.g. 2026-W44
  signals          INTEGER NOT NULL,
  expectancy_r     REAL,
  brier            REAL,
  p_value          REAL,
  p_value_bh       REAL,
  status           TEXT NOT NULL,
  PRIMARY KEY (skill_id, week)
);

CREATE TABLE governor_proposals (
  proposal_id      TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  kind             TEXT NOT NULL,                  -- DOCTRINE, SCAR, CALIBRATION, SKILL_PROMOTION, LADDER
  pr_url           TEXT,
  summary          TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  status           TEXT CHECK (status IN ('OPEN','MERGED','REJECTED','SUPERSEDED')) NOT NULL DEFAULT 'OPEN'
);

CREATE TABLE budget_daily (
  day              TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  resource         TEXT NOT NULL,
  used             REAL NOT NULL,
  limit_value      REAL NOT NULL,
  peak_mode        TEXT NOT NULL,
  PRIMARY KEY (day, resource)
);

CREATE TABLE batch_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at      INTEGER NOT NULL,
  produced_at      INTEGER NOT NULL,
  job              TEXT NOT NULL,                  -- e.g. crypto-regime, equity-breadth, screeners
  skill_id         TEXT NOT NULL,
  version          TEXT NOT NULL,
  inputs_sha256    TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  run_url          TEXT                            -- GitHub Actions run link (provenance)
);
CREATE INDEX batch_skill_time ON batch_results(skill_id, produced_at);

CREATE TABLE postmortems (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       INTEGER NOT NULL,
  contract_id      TEXT NOT NULL,
  account          TEXT NOT NULL,
  classification   TEXT CHECK (classification IN (
                     'GOOD_PROCESS_GOOD_OUTCOME','GOOD_PROCESS_BAD_LUCK',
                     'BAD_PROCESS_BAILOUT_LUCK','BAD_PROCESS_LOSS')) NOT NULL,
  realized_r       REAL NOT NULL,
  notes            TEXT NOT NULL,
  author           TEXT NOT NULL                   -- 'governor' or 'operator'
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (U7)
-- ---------------------------------------------------------------------------
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER contracts_no_update BEFORE UPDATE ON decision_contracts BEGIN SELECT RAISE(ABORT, 'decision_contracts is append-only'); END;
CREATE TRIGGER contracts_no_delete BEFORE DELETE ON decision_contracts BEGIN SELECT RAISE(ABORT, 'decision_contracts is append-only'); END;
CREATE TRIGGER orders_log_no_update BEFORE UPDATE ON orders_log BEGIN SELECT RAISE(ABORT, 'orders_log is append-only'); END;
CREATE TRIGGER orders_log_no_delete BEFORE DELETE ON orders_log BEGIN SELECT RAISE(ABORT, 'orders_log is append-only'); END;
CREATE TRIGGER fills_no_update BEFORE UPDATE ON fills BEGIN SELECT RAISE(ABORT, 'fills is append-only'); END;
CREATE TRIGGER fills_no_delete BEFORE DELETE ON fills BEGIN SELECT RAISE(ABORT, 'fills is append-only'); END;
CREATE TRIGGER rejections_no_update BEFORE UPDATE ON rejections BEGIN SELECT RAISE(ABORT, 'rejections is append-only'); END;
CREATE TRIGGER rejections_no_delete BEFORE DELETE ON rejections BEGIN SELECT RAISE(ABORT, 'rejections is append-only'); END;
CREATE TRIGGER rejection_grades_no_update BEFORE UPDATE ON rejection_grades BEGIN SELECT RAISE(ABORT, 'rejection_grades is append-only'); END;
CREATE TRIGGER rejection_grades_no_delete BEFORE DELETE ON rejection_grades BEGIN SELECT RAISE(ABORT, 'rejection_grades is append-only'); END;
CREATE TRIGGER postmortems_no_update BEFORE UPDATE ON postmortems BEGIN SELECT RAISE(ABORT, 'postmortems is append-only'); END;
CREATE TRIGGER postmortems_no_delete BEFORE DELETE ON postmortems BEGIN SELECT RAISE(ABORT, 'postmortems is append-only'); END;
