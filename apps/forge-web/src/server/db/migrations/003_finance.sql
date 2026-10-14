-- FINCO Forge W04 — economics & treasury.
--
-- The financial ledger is a deterministic projection over chain_events
-- (src/server/finance/ledger.ts); it has no tables of its own, so there is
-- no second source of truth and reorg handling is inherited from the W03
-- indexer. The only durable W04 state is the record of claim transactions a
-- recipient reports having sent, used to show pending/failed status before
-- the indexer confirms the escrow/splitter claim event.
CREATE TABLE fin_claim_submissions (
  tx_hash text PRIMARY KEY,
  wallet text NOT NULL,
  asset text NOT NULL,
  kind text NOT NULL,                       -- escrow | treasury
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_claim_submissions_wallet ON fin_claim_submissions(wallet);
