-- Per-user monotonic counter that the extension polls via /license/heartbeat.
-- Bumped whenever a license is granted, revoked, or subscription state changes.
-- The extension force-refreshes its license JWT when this number changes.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS license_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS license_revoked_at TIMESTAMPTZ;
