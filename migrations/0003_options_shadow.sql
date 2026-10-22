-- Phase 5 options shadow lab (ADR-031): a virtual ledger, never sent to a broker. One OPEN and at most one CLOSE
-- row per trade_id; append-only like the journal (U7).
CREATE TABLE options_shadow (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('OPEN','CLOSE')),
  ts                 INTEGER NOT NULL,
  strategy           TEXT NOT NULL,
  structure          TEXT NOT NULL,
  underlying         TEXT NOT NULL,
  legs_json          TEXT NOT NULL,
  cash               REAL NOT NULL,          -- per share: OPEN > 0 credit / < 0 debit; CLOSE = cash to close (or settle)
  max_loss_cents     INTEGER NOT NULL CHECK (max_loss_cents > 0),
  max_profit_cents   INTEGER,
  fees_cents         INTEGER NOT NULL,
  pnl_cents          INTEGER,                -- CLOSE only, after modeled fees
  r                  REAL,                   -- CLOSE only: pnl / max loss
  reason             TEXT,                   -- CLOSE only: TARGET | STOP | TIME | EXPIRY
  sizer_permits_live INTEGER NOT NULL,       -- 1 if max loss fits the LIVE per-trade risk cap at R1
  detail_json        TEXT NOT NULL,
  UNIQUE (trade_id, kind)
);
CREATE INDEX options_shadow_strategy ON options_shadow(strategy, kind, ts);
CREATE TRIGGER options_shadow_no_update BEFORE UPDATE ON options_shadow BEGIN SELECT RAISE(ABORT, 'options_shadow is append-only'); END;
CREATE TRIGGER options_shadow_no_delete BEFORE DELETE ON options_shadow BEGIN SELECT RAISE(ABORT, 'options_shadow is append-only'); END;
