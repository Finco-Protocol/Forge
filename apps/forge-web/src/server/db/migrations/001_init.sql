-- FINCO Forge W03 — durable verification, binding, launch and indexer state.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ── Identity & sessions ────────────────────────────────────────────────
CREATE TABLE github_users (
  github_user_id bigint PRIMARY KEY,
  login text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,                 -- sha256(session token); the token itself is never stored
  github_user_id bigint REFERENCES github_users(github_user_id),
  github_token_enc text,                    -- AES-256-GCM encrypted user-to-server token
  github_token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  session_id_hash text NOT NULL REFERENCES sessions(id_hash),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE wallet_challenges (
  nonce text PRIMARY KEY,
  session_id_hash text NOT NULL REFERENCES sessions(id_hash),
  github_user_id bigint NOT NULL,
  address text NOT NULL,
  chain_id integer NOT NULL,
  domain text NOT NULL,
  message text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE wallet_bindings (
  id bigserial PRIMARY KEY,
  github_user_id bigint NOT NULL REFERENCES github_users(github_user_id),
  wallet_address text NOT NULL,
  chain_id integer NOT NULL,
  siwe_message text NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text
);
-- One active wallet per GitHub identity, and one GitHub identity per active wallet.
CREATE UNIQUE INDEX wallet_bindings_active_user ON wallet_bindings(github_user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX wallet_bindings_active_wallet ON wallet_bindings(wallet_address) WHERE revoked_at IS NULL;

-- ── GitHub App state ───────────────────────────────────────────────────
CREATE TABLE installations (
  installation_id bigint PRIMARY KEY,
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL,
  suspended_at timestamptz,
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repositories (
  repo_id bigint PRIMARY KEY,               -- canonical numeric GitHub id
  full_name text NOT NULL,
  owner_id bigint NOT NULL,
  owner_login text NOT NULL,
  installation_id bigint,
  private boolean NOT NULL,
  fork boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  default_branch text NOT NULL,
  ineligible_reason text,                   -- non-null = new launches refused
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repository_names (
  repo_id bigint NOT NULL,
  full_name text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  PRIMARY KEY (repo_id, full_name)
);

-- Immutable verification evidence. Only revocation columns may change.
CREATE TABLE verifications (
  id uuid PRIMARY KEY,
  repo_id bigint NOT NULL,
  github_user_id bigint NOT NULL,
  github_login text NOT NULL,
  installation_id bigint NOT NULL,
  wallet_binding_id bigint REFERENCES wallet_bindings(id),
  wallet_address text,
  full_name text NOT NULL,
  owner_login text NOT NULL,
  owner_id bigint NOT NULL,
  default_branch text NOT NULL,
  commit_sha text NOT NULL,
  private boolean NOT NULL,
  user_permission text NOT NULL,            -- from the user's own token
  installation_permission text NOT NULL,    -- from the installation token (collaborator permission)
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX verifications_repo ON verifications(repo_id);

CREATE FUNCTION forge_verifications_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'verifications are append-only'; END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoke_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoke_reason') THEN
    RAISE EXCEPTION 'verification evidence is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'verification revocation is final';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER verifications_immutable BEFORE UPDATE OR DELETE ON verifications
  FOR EACH ROW EXECUTE FUNCTION forge_verifications_immutable();

CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  action text,
  payload_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome text
);

-- ── Eligibility authority ──────────────────────────────────────────────
CREATE TABLE registry_ops (
  id bigserial PRIMARY KEY,
  repo_id bigint NOT NULL,
  op_nonce bigint NOT NULL,
  parent_digest text NOT NULL,
  op_digest text NOT NULL UNIQUE,
  creator text NOT NULL,
  revoke boolean NOT NULL,
  repo_full_name text NOT NULL,
  binding_expires_at bigint NOT NULL,
  op_deadline bigint NOT NULL,
  verification_id uuid REFERENCES verifications(id),
  reason text NOT NULL,
  signature text NOT NULL,
  status text NOT NULL,                     -- signed | submitted | confirmed | failed | abandoned
  tx_hash text,
  block_number bigint,
  binding_epoch bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Two operations against the same (sequence, parent) are mutually exclusive on chain;
-- the service never even signs the second one.
CREATE UNIQUE INDEX registry_ops_slot ON registry_ops(repo_id, op_nonce, parent_digest);

CREATE TABLE attestations (
  id uuid PRIMARY KEY,
  verification_id uuid NOT NULL REFERENCES verifications(id),
  repo_id bigint NOT NULL,
  creator text NOT NULL,
  binding_epoch bigint NOT NULL,
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  digest text NOT NULL,
  payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signing_requests (
  id bigserial PRIMARY KEY,
  role text NOT NULL,
  kind text NOT NULL,
  digest text,
  decision text NOT NULL,                   -- allowed | denied
  reason text,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Launches ───────────────────────────────────────────────────────────
CREATE TABLE launch_drafts (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL,
  creator text NOT NULL,
  repo_id bigint NOT NULL,
  params jsonb NOT NULL,                    -- token metadata + launch options (exact factory inputs)
  economics jsonb NOT NULL,                 -- preview snapshot read from the factory
  economics_digest text NOT NULL,
  predicted_token text,
  predicted_curve text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE launch_intents (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES launch_drafts(id),
  verification_id uuid NOT NULL REFERENCES verifications(id),
  attestation_id uuid NOT NULL REFERENCES attestations(id),
  creator text NOT NULL,
  repo_id bigint NOT NULL,
  intent jsonb NOT NULL,                    -- IForgeLaunchAuthorizer.LaunchIntent (raw metadata hash)
  consent_digest text NOT NULL,
  nonce bigint NOT NULL,
  expires_at bigint NOT NULL,
  creator_signature text,
  status text NOT NULL,                     -- awaiting_signature | signed | submitted | included | confirmed | failed | expired | superseded
  tx_hash text,
  token_address text,
  curve_address text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one live intent per draft: retries never produce duplicate launches.
CREATE UNIQUE INDEX launch_intents_live_per_draft ON launch_intents(draft_id)
  WHERE status IN ('awaiting_signature', 'signed', 'submitted', 'included');
CREATE UNIQUE INDEX launch_intents_tx ON launch_intents(tx_hash) WHERE tx_hash IS NOT NULL;

-- ── Chain indexer ──────────────────────────────────────────────────────
CREATE TABLE indexer_checkpoints (
  name text PRIMARY KEY,
  chain_id integer NOT NULL,
  factory text NOT NULL,
  last_block bigint NOT NULL,
  last_block_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE indexed_blocks (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_timestamp bigint NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE chain_events (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  address text NOT NULL,
  event_name text NOT NULL,
  args jsonb NOT NULL,
  block_timestamp bigint NOT NULL,
  PRIMARY KEY (chain_id, block_hash, log_index)
);
CREATE INDEX chain_events_tx ON chain_events(tx_hash);
CREATE INDEX chain_events_block ON chain_events(chain_id, block_number);

CREATE TABLE tokens (
  token text PRIMARY KEY,
  chain_id integer NOT NULL,
  factory text NOT NULL,
  curve text NOT NULL,
  creator text NOT NULL,
  pair_token text NOT NULL,
  launch_config_id bigint NOT NULL,
  graduation_threshold numeric(78,0) NOT NULL,
  github_repo_id bigint,
  launch_tx text NOT NULL,
  launch_block bigint NOT NULL,
  launched_at bigint NOT NULL,
  name text,
  symbol text,
  phase text NOT NULL,
  onchain_phase integer,
  reconciled_at timestamptz,
  reconcile_error text,
  buy_count integer NOT NULL DEFAULT 0,
  sell_count integer NOT NULL DEFAULT 0,
  quote_volume numeric(78,0) NOT NULL DEFAULT 0,
  curve_quote_reserve numeric(78,0),
  position_id numeric(78,0),
  liquidity_locked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Jobs (webhook-driven on-chain revocations, reconciliation) ─────────
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending | done | failed
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Proof of Build: append-only, hash-chained, signed evidence ledger ──
CREATE TABLE evidence_receipts (
  seq bigint PRIMARY KEY,
  prev_hash text NOT NULL,
  kind text NOT NULL,                       -- launch | retraction (reorged-out launch)
  token text NOT NULL,
  receipt jsonb NOT NULL,
  receipt_hash text NOT NULL,
  signer text NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION forge_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER evidence_receipts_append_only BEFORE UPDATE OR DELETE ON evidence_receipts
  FOR EACH ROW EXECUTE FUNCTION forge_append_only();

-- ── Audit & rate limiting ──────────────────────────────────────────────
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  subject text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forge_append_only();

CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
