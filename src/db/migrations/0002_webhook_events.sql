CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error TEXT,
  payload JSONB NOT NULL
);
CREATE INDEX idx_webhook_events_unprocessed ON webhook_events (received_at) WHERE processed_at IS NULL;
