-- FINCO Forge W04 — economics & treasury.
--
-- The financial ledger is a deterministic projection over chain_events
-- (src/server/finance/ledger.ts); it has no tables of its own, so there is
-- no second source of truth and reorg handling is inherited from the W03
-- indexer. The only durable W04 state is the record of claim transactions a
-- recipient reports having sent, used to show pending/failed status before
-- the indexer confirms the escrow/splitter claim event.
--
-- Correction A: a submission is NEVER treated as valid on its own. When the
-- transaction is visible its decoded contents (chain, sender, canonical
-- contract, selector, asset, nominal amount) are verified and stored; a hash
-- whose contents are not yet visible stays UNVERIFIED_PENDING, and success
-- requires the canonical indexed escrow/splitter claim event.
CREATE TABLE fin_claim_submissions (
  tx_hash text PRIMARY KEY,
  wallet text NOT NULL,
  asset text NOT NULL,
  kind text NOT NULL,                       -- escrow | treasury
  chain_id integer NOT NULL,
  target text NOT NULL,                     -- canonical escrow or splitter address
  selector text,                            -- verified 4-byte selector (null until visible)
  nominal_amount numeric(78, 0),            -- decoded amount; 0 = full balance (null until visible)
  contents_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_claim_submissions_wallet ON fin_claim_submissions(wallet);
