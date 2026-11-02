-- Audit HUB-01/03/04: moderation (hidden agents and packs, reports), per-network agent creation, per-address pack counts.
ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN ip TEXT;
ALTER TABLE packs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS agents_ip ON agents(ip, first_seen);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_ip ON reports(ip, at);
CREATE TABLE IF NOT EXISTS pack_fetches (
  pack_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (pack_id, ip, day)
);
-- Audit HUB-02: rows that carried the account's balance are no longer public.
DELETE FROM rows WHERE kind = 'DAY_ROLL';
