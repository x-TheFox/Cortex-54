-- Audit BL-3: the daily quota checks count rows and packs per agent per day; index them.
CREATE INDEX IF NOT EXISTS rows_received ON rows(agent_id, received_at);
CREATE INDEX IF NOT EXISTS packs_agent ON packs(agent_id, created_at);
CREATE INDEX IF NOT EXISTS agents_first_seen ON agents(first_seen);
