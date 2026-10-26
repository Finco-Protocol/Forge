-- W07 Correction A: indexes for the durable delivery lifecycle queries.
-- The retry scan selects RECEIVED, signature-verified deliveries ordered by
-- received_at (both the backoff-due rows and the crash-window rows); the
-- monitor counts terminal-failed rows. The partial index from 007 covered
-- neither the received_at ordering nor the full predicate shape.
CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx
  ON webhook_deliveries (received_at)
  WHERE status = 'received' AND signature_verified;

CREATE INDEX IF NOT EXISTS webhook_deliveries_failed_idx
  ON webhook_deliveries (received_at)
  WHERE status = 'failed';
