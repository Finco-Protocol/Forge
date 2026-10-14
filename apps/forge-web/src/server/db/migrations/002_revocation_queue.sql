-- W03 Correction A: revocation-first durable queue with latency tracking.
ALTER TABLE jobs ADD COLUMN priority integer NOT NULL DEFAULT 100;
ALTER TABLE jobs ADD COLUMN completed_at timestamptz;
ALTER TABLE jobs ADD COLUMN alerted_at timestamptz;
UPDATE jobs SET priority = 0 WHERE kind = 'registry_revoke';
UPDATE jobs SET priority = 10 WHERE kind = 'repo_revalidate';
CREATE INDEX jobs_ready ON jobs(status, priority, run_after, id);

-- Priority is a property of the job kind, never of the caller.
CREATE FUNCTION forge_job_priority() RETURNS trigger AS $$
BEGIN
  NEW.priority := CASE NEW.kind WHEN 'registry_revoke' THEN 0 WHEN 'repo_revalidate' THEN 10 ELSE 100 END;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER jobs_priority BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION forge_job_priority();

-- A failed or abandoned (never-landed) registry op must not block a retry of the
-- same (sequence, parent) slot. On chain, ops for one slot remain mutually
-- exclusive (Correction B), so only LIVE ops need durable exclusion here.
DROP INDEX registry_ops_slot;
CREATE UNIQUE INDEX registry_ops_slot ON registry_ops(repo_id, op_nonce, parent_digest)
  WHERE status IN ('signed', 'submitted', 'confirmed');
