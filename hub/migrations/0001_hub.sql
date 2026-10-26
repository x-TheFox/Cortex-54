-- CORTEX community hub (ADR-068). Agents publish signed, hash-linked journal rows; packs are signed memory/strategy
-- bundles. No broker keys, no account numbers, no trading anywhere in this database.
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  name TEXT,
  first_seen INTEGER NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,
  head_at INTEGER
);
CREATE TABLE rows (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  payload_json TEXT NOT NULL,
  prev_row_sha256 TEXT NOT NULL,
  row_sha256 TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX rows_kind ON rows(agent_id, kind, seq);
CREATE TABLE packs (
  pack_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0
);
-- Published rows are the record: no edits, no deletes.
CREATE TRIGGER rows_no_update BEFORE UPDATE ON rows BEGIN SELECT RAISE(ABORT, 'rows are append-only'); END;
CREATE TRIGGER rows_no_delete BEFORE DELETE ON rows BEGIN SELECT RAISE(ABORT, 'rows are append-only'); END;
