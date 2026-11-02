-- ADR-102: the community impact pledge (20% of gross revenue to community-suggested foundations, monthly).
CREATE TABLE IF NOT EXISTS impact_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,          -- website domain (d:…) or cleaned name (n:…): duplicates merge on it
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  reason TEXT NOT NULL DEFAULT '',
  votes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'listed', -- listed | rejected (not a registered nonprofit, or a duplicate merged by hand)
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS impact_suggestions_rank ON impact_suggestions(status, votes DESC, created_at);
CREATE INDEX IF NOT EXISTS impact_suggestions_name ON impact_suggestions(name_key);
CREATE INDEX IF NOT EXISTS impact_suggestions_ip ON impact_suggestions(ip, created_at);
CREATE TABLE IF NOT EXISTS impact_votes (
  suggestion_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  month TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (suggestion_id, ip, month)
);
CREATE INDEX IF NOT EXISTS impact_votes_ip ON impact_votes(ip, month);
CREATE TABLE IF NOT EXISTS impact_months (
  month TEXT PRIMARY KEY,            -- YYYY-MM (UTC)
  gross_cents INTEGER NOT NULL,
  refunds_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  pool_cents INTEGER NOT NULL,
  slots INTEGER NOT NULL,
  charges INTEGER NOT NULL,
  status TEXT NOT NULL,              -- live | published
  computed_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE TABLE IF NOT EXISTS impact_allocations (
  month TEXT NOT NULL,
  suggestion_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  votes INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_cents INTEGER,
  receipt_url TEXT,
  paid_at INTEGER,
  PRIMARY KEY (month, suggestion_id)
);
-- a published month's allocation can be marked paid, never changed or removed
CREATE TRIGGER IF NOT EXISTS impact_allocations_no_delete BEFORE DELETE ON impact_allocations
BEGIN SELECT RAISE(ABORT, 'impact allocations are a public record: append-only'); END;
CREATE TRIGGER IF NOT EXISTS impact_allocations_fixed BEFORE UPDATE OF month, suggestion_id, name, amount_cents ON impact_allocations
BEGIN SELECT RAISE(ABORT, 'impact allocations are a public record: amounts never change'); END;
