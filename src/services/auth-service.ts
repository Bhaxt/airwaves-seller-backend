import { randomBytes, createHash, randomInt } from 'crypto';
import { db } from '../db/client.js';
import { signAccessToken } from '../lib/jwt.js';
import { sendMagicLink } from './email-service.js';
import { unauthorized } from '../lib/errors.js';
import { featuresForTier } from './tier-map.js';
import type { User, AuthTokenPair } from '../types/index.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function generateOtpCode(): string {
  // 6-digit numeric code, zero-padded ('012345' allowed)
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

async function getOrCreateUser(email: string): Promise<User> {
  const existing = await db<User[]>`
    SELECT * FROM users WHERE email = ${email} AND deleted_at IS NULL
  `;
  if (existing.length > 0) return existing[0];

  const created = await db<User[]>`
    INSERT INTO users (email) VALUES (${email}) RETURNING *
  `;
  return created[0];
}

export async function initiateLogin(opts: {
  email: string;
  ip?: string;
  userAgent?: string;
  clientType?: string;
}): Promise<{ devToken?: string; devCode?: string }> {
  const user = await getOrCreateUser(opts.email);
  const token = generateToken();
  const tokenHash = sha256(token);
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  // Invalidate any prior unconsumed codes for this user — only the latest works
  await db`
    UPDATE magic_links
    SET consumed_at = now()
    WHERE user_id = ${user.id} AND consumed_at IS NULL
  `;

  await db`
    INSERT INTO magic_links (user_id, token_hash, code, expires_at, ip, user_agent)
    VALUES (
      ${user.id}, ${tokenHash}, ${code}, ${expiresAt},
      ${opts.ip ?? null}, ${opts.userAgent ?? null}
    )
  `;

  await db`
    INSERT INTO audit_log (user_id, action, subject, ip)
    VALUES (${user.id}, 'magic_link.issued', ${opts.email}, ${opts.ip ?? null})
  `;

  await sendMagicLink({ to: opts.email, token, code, clientType: opts.clientType });

  if (process.env.NODE_ENV === 'test') return { devToken: token, devCode: code };
  return {};
}

/**
 * Verify a 6-digit OTP code against the most recent magic_link for this email.
 * Bound by email so that codes alone (only 1M combinations) are not brute-forceable.
 * Code expires in 15 min same as the link.
 */
export async function verifyMagicLinkCode(opts: {
  email: string;
  code: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ user: User; tokens: AuthTokenPair }> {
  const now = new Date();

  const links = await db`
    SELECT ml.id, ml.user_id, u.email
    FROM magic_links ml
    JOIN users u ON u.id = ml.user_id
    WHERE u.email = ${opts.email}
      AND ml.code = ${opts.code}
      AND ml.consumed_at IS NULL
      AND ml.expires_at > ${now}
      AND u.deleted_at IS NULL
    ORDER BY ml.created_at DESC
    LIMIT 1
  `;

  if (links.length === 0) throw unauthorized('Invalid or expired code');

  const link = links[0];

  await db`UPDATE magic_links SET consumed_at = ${now} WHERE id = ${link.id}`;

  const users = await db<User[]>`
    UPDATE users SET last_login_at = ${now} WHERE id = ${link.user_id} RETURNING *
  `;
  const user = users[0];

  await db`
    INSERT INTO audit_log (user_id, action, subject, ip)
    VALUES (${user.id}, 'magic_link.consumed_code', ${user.email}, ${opts.ip ?? null})
  `;

  const tokens = await createSession({ user, ip: opts.ip, userAgent: opts.userAgent });
  return { user, tokens };
}

export async function verifyMagicLink(opts: {
  token: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ user: User; tokens: AuthTokenPair }> {
  const tokenHash = sha256(opts.token);
  const now = new Date();

  const links = await db`
    SELECT ml.id, ml.user_id, u.email
    FROM magic_links ml
    JOIN users u ON u.id = ml.user_id
    WHERE ml.token_hash = ${tokenHash}
      AND ml.consumed_at IS NULL
      AND ml.expires_at > ${now}
      AND u.deleted_at IS NULL
  `;

  if (links.length === 0) throw unauthorized('Invalid or expired magic link');

  const link = links[0];

  await db`
    UPDATE magic_links SET consumed_at = ${now} WHERE id = ${link.id}
  `;

  const users = await db<User[]>`
    UPDATE users SET last_login_at = ${now} WHERE id = ${link.user_id} RETURNING *
  `;
  const user = users[0];

  await db`
    INSERT INTO audit_log (user_id, action, subject, ip)
    VALUES (${user.id}, 'magic_link.consumed', ${user.email}, ${opts.ip ?? null})
  `;

  const tokens = await createSession({ user, ip: opts.ip, userAgent: opts.userAgent });
  return { user, tokens };
}

export async function createSession(opts: {
  user: User;
  ip?: string;
  userAgent?: string;
}): Promise<AuthTokenPair> {
  const { user } = opts;

  const subs = await db`
    SELECT tier FROM subscriptions
    WHERE user_id = ${user.id}
      AND status IN ('active', 'trialing', 'past_due')
    ORDER BY created_at DESC LIMIT 1
  `;
  const tier = subs.length > 0 ? subs[0].tier : 'free_trial';
  const features = featuresForTier(tier);

  const accessToken = await signAccessToken({ sub: user.id, email: user.email, tier, features });

  const refreshToken = generateToken();
  const refreshHash = sha256(refreshToken);
  const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db`
    INSERT INTO sessions (user_id, refresh_token_hash, expires_at, ip, user_agent)
    VALUES (${user.id}, ${refreshHash}, ${refreshExpiry}, ${opts.ip ?? null}, ${opts.userAgent ?? null})
  `;

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

export async function refreshSession(opts: {
  refreshToken: string;
  ip?: string;
  userAgent?: string;
}): Promise<AuthTokenPair> {
  const tokenHash = sha256(opts.refreshToken);
  const now = new Date();

  const sessions = await db`
    SELECT s.id, s.user_id
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.refresh_token_hash = ${tokenHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > ${now}
      AND u.deleted_at IS NULL
  `;

  if (sessions.length === 0) throw unauthorized('Invalid or expired refresh token');
  const session = sessions[0];

  await db`UPDATE sessions SET revoked_at = ${now} WHERE id = ${session.id}`;

  await db`
    INSERT INTO audit_log (user_id, action, ip)
    VALUES (${session.user_id}, 'session.refreshed', ${opts.ip ?? null})
  `;

  const users = await db<User[]>`SELECT * FROM users WHERE id = ${session.user_id}`;
  return createSession({ user: users[0], ip: opts.ip, userAgent: opts.userAgent });
}

export async function revokeSession(refreshToken: string): Promise<void> {
  const tokenHash = sha256(refreshToken);

  const existing = await db`
    SELECT user_id FROM sessions WHERE refresh_token_hash = ${tokenHash} AND revoked_at IS NULL
  `;
  if (existing.length === 0) throw unauthorized('Session not found');

  await db`
    UPDATE sessions SET revoked_at = now()
    WHERE refresh_token_hash = ${tokenHash} AND revoked_at IS NULL
  `;

  await db`
    INSERT INTO audit_log (user_id, action)
    VALUES (${existing[0].user_id}, 'session.revoked')
  `;
}

export async function getMe(userId: string): Promise<object> {
  const users = await db<User[]>`SELECT * FROM users WHERE id = ${userId} AND deleted_at IS NULL`;
  if (users.length === 0) throw unauthorized('User not found');
  const user = users[0];

  const subs = await db`
    SELECT tier, status, grace_until, current_period_end, cancel_at_period_end
    FROM subscriptions
    WHERE user_id = ${userId}
      AND status IN ('active', 'trialing', 'past_due')
    ORDER BY created_at DESC LIMIT 1
  `;

  const tier = subs.length > 0 ? subs[0].tier : 'free_trial';
  const features = featuresForTier(tier);

  return {
    id: user.id,
    email: user.email,
    tier,
    subscriptionStatus: subs.length > 0 ? subs[0].status : null,
    gracePeriodUntil: subs.length > 0 ? subs[0].grace_until : null,
    cancelAtPeriodEnd: subs.length > 0 ? subs[0].cancel_at_period_end : false,
    features,
  };
}
