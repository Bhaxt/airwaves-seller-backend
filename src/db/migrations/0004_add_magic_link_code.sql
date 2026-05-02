-- Adds a 6-digit numeric verification code to magic_links so users can paste
-- the code from their email instead of clicking a link (better UX for
-- the Chrome extension where deep-linking back is tricky).
--
-- The code is stored alongside the existing token_hash; either path works:
--   • GET  /auth/verify?token=<hex>      ← link flow (legacy)
--   • POST /auth/verify-code  {email,code} ← OTP flow (new, primary)

ALTER TABLE magic_links
  ADD COLUMN IF NOT EXISTS code CHAR(6);

-- Speed up code lookups joined with user_id (we always know the email)
CREATE INDEX IF NOT EXISTS idx_magic_links_user_code_active
  ON magic_links (user_id, code)
  WHERE consumed_at IS NULL;
