-- FINCO Forge W05 — operator controls.
--
-- Immediate, off-chain containment switches (see src/server/ops/controls.ts).
-- Changed only by the audited operator CLI (scripts/w05/ops-control.ts);
-- no HTTP endpoint writes this table.
CREATE TABLE ops_controls (
  key text PRIMARY KEY,
  active boolean NOT NULL,
  reason text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
