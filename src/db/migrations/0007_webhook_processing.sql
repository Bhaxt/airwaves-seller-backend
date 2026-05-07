-- Track when a webhook event started processing. Combined with processed_at,
-- this distinguishes three states for any (id) row:
--   processing_started_at IS NOT NULL AND processed_at IS NULL → in-flight
--   processing_started_at IS NOT NULL AND processed_at IS NOT NULL → done
--   processing_started_at IS NULL → previous attempt failed; safe to retry
--
-- Closes the race where Stripe's retry of an in-flight event saw a row already
-- present, returned 200, and let a side-effect failure go un-retried after the
-- original DELETE'd its idempotency row.
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
