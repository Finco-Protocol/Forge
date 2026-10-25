-- W07: webhook delivery lifecycle. A delivery is durably RECEIVED (after
-- constant-time signature verification, before any trust is placed in the
-- payload) in its own committed transaction, then PROCESSED in a second
-- transaction that carries all side effects. A processing failure leaves the
-- receipt behind with its attempt count, last error and next retry time, so
-- monitoring can observe it and the worker can retry it (bounded, then
-- terminal 'failed' — visible, and recoverable by a GitHub redelivery).
-- Historical rows (pre-W07) were only ever written on success: mark them
-- processed and verified so the lifecycle state stays truthful.
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS signature_verified boolean NOT NULL DEFAULT false;

UPDATE webhook_deliveries SET status = 'processed', signature_verified = true WHERE processed_at IS NOT NULL AND status = 'received';

CREATE INDEX IF NOT EXISTS webhook_deliveries_retry_idx
  ON webhook_deliveries (next_retry_at)
  WHERE status = 'received' AND attempts > 0;
