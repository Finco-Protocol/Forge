-- FINCO Forge W05 — materialized financial ledger + production DB operations.
--
-- ADDITIVE ONLY. The W03 indexer's `chain_events` stays the canonical source
-- of truth; everything here is a derived cache or operational state:
--
--   ledger_snapshots  — serialized fold state of the W04 ledger at an indexer
--                       checkpoint block, keyed by (chain, ledger context,
--                       block number) and pinned to the block hash. Written
--                       in the SAME transaction as the checkpoint; a snapshot
--                       is used only while its (block_number, block_hash) is
--                       still present in `indexed_blocks` (i.e. canonical).
--                       Deleted by the indexer's reorg rollback.
--   ledger_integrity  — fail-closed flag per chain: a materialized-vs-rebuild
--                       divergence or an unexplained splitter deficit sets
--                       `halted`; the revenue attestor refuses to sign while
--                       halted or while the last self-check did not pass.
--   worker_heartbeats — liveness of each worker process (health endpoint).
--
-- Rollback policy: forward-only. There is no down migration; dropping these
-- tables loses only derived data (snapshots are rebuilt from chain_events by
-- `pnpm ledger:rebuild`).
CREATE TABLE ledger_snapshots (
  chain_id integer NOT NULL,
  context_key text NOT NULL,                -- sha256(fold version + ledger context addresses)
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  fold_version integer NOT NULL,
  event_count bigint NOT NULL,              -- canonical chain_events with block_number <= block_number
  state text NOT NULL,                      -- encodeFoldState() (order-preserving JSON)
  state_sha256 text NOT NULL,
  ledger_digest text NOT NULL,              -- ledgerDigest(finalizeFold(state))
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, context_key, block_number)
);

CREATE TABLE ledger_integrity (
  chain_id integer PRIMARY KEY,
  halted boolean NOT NULL DEFAULT false,
  halt_reason text,
  halted_at timestamptz,
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_detail jsonb,
  cleared_at timestamptz,
  cleared_by text
);

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  application_name text NOT NULL,
  pid integer NOT NULL,
  hostname text NOT NULL,
  state text NOT NULL,                      -- starting | running | stopping | stopped
  started_at timestamptz NOT NULL DEFAULT now(),
  beat_at timestamptz NOT NULL DEFAULT now(),
  passes bigint NOT NULL DEFAULT 0,
  last_pass_ms integer,
  last_error text
);
CREATE INDEX worker_heartbeats_beat ON worker_heartbeats(beat_at DESC);
