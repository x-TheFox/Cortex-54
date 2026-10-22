-- Phase 1: deterministic (RULE) vs court (COURT) contracts. ADD COLUMN is DDL, not a row UPDATE,
-- so the append-only triggers (U7) are unaffected.
ALTER TABLE decision_contracts ADD COLUMN origin TEXT NOT NULL DEFAULT 'COURT' CHECK (origin IN ('RULE','COURT'));
