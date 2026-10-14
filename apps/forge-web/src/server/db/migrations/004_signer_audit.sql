-- FINCO Forge W05 — signer custody controls (additive; docs/W05-SIGNER-CUSTODY.md).
--
-- signer_audit       append-only record of EVERY custody request (allowed,
--                    denied or failed): role, key version, EIP-712 domain and
--                    primary type (or EIP-191), digest, correlation id.
-- signer_signatures  replay/concurrency guard: at most ONE signature per
--                    (role, digest). A concurrent or repeated identical request
--                    receives the stored signature instead of a second custody call.
-- signer_keys        key versions per role. Only `active` signs; `retired`
--                    (rotated out) and `revoked` never sign; `revoked` is
--                    terminal; an address belongs to exactly one role, ever.
-- signer_kill_switch incident kill switch per role (or 'all'), checked on every sign.
CREATE TABLE signer_audit (
  id bigserial PRIMARY KEY,
  correlation_id text NOT NULL,
  role text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allowed', 'denied', 'failed')),
  reason text,
  replayed boolean NOT NULL DEFAULT false,
  signer_address text,
  key_version integer,
  custody text,
  payload_kind text,                        -- eip712 | eip191
  chain_id bigint,
  verifying_contract text,
  domain_name text,
  domain_version text,
  primary_type text,
  digest text,
  idempotency_key text,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signer_audit_role_time ON signer_audit(role, created_at);
CREATE INDEX signer_audit_correlation ON signer_audit(correlation_id);
CREATE TRIGGER signer_audit_append_only BEFORE UPDATE OR DELETE ON signer_audit
  FOR EACH ROW EXECUTE FUNCTION forge_append_only();

CREATE TABLE signer_signatures (
  role text NOT NULL,
  digest text NOT NULL,
  idempotency_key text,
  state text NOT NULL CHECK (state IN ('pending', 'signed')),
  signature text,
  signer_address text NOT NULL,
  key_version integer,
  correlation_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  PRIMARY KEY (role, digest),
  CHECK ((state = 'signed') = (signature IS NOT NULL))
);
CREATE UNIQUE INDEX signer_signatures_idempotency ON signer_signatures(role, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE signer_keys (
  role text NOT NULL CHECK (role IN ('authority', 'evidence', 'revenue')),
  version integer NOT NULL CHECK (version > 0),
  address text NOT NULL,
  custody text NOT NULL,                    -- local-test | kms | hsm
  key_ref text,                             -- KMS key id / ARN; never key material
  status text NOT NULL CHECK (status IN ('active', 'retired', 'revoked')),
  status_reason text,
  changed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, version),
  UNIQUE (address)
);
CREATE UNIQUE INDEX signer_keys_one_active ON signer_keys(role) WHERE status = 'active';

CREATE FUNCTION forge_signer_keys_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signer_keys rows are never deleted'; END IF;
  IF NEW.role <> OLD.role OR NEW.version <> OLD.version OR NEW.address <> OLD.address OR NEW.custody <> OLD.custody OR NEW.key_ref IS DISTINCT FROM OLD.key_ref THEN
    RAISE EXCEPTION 'signer_keys identity columns are immutable';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN RAISE EXCEPTION 'a revoked signer key can never be reinstated'; END IF;
  IF OLD.status = 'retired' AND NEW.status = 'active' THEN RAISE EXCEPTION 'a retired signer key can never be reactivated'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER signer_keys_guard BEFORE UPDATE OR DELETE ON signer_keys
  FOR EACH ROW EXECUTE FUNCTION forge_signer_keys_guard();

CREATE TABLE signer_kill_switch (
  role text PRIMARY KEY CHECK (role IN ('authority', 'evidence', 'revenue', 'all')),
  engaged boolean NOT NULL,
  reason text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
