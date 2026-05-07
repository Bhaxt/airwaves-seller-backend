import { db } from '../db/client.js';
import { signLicenseJwt } from '../lib/jwt.js';
import { featuresForTier } from './tier-map.js';
import { forbidden } from '../lib/errors.js';
import { config } from '../config.js';

/**
 * Bump the per-user monotonic license_version. Called whenever a license is
 * granted, revoked, or subscription state changes. The extension short-polls
 * /license/heartbeat and force-refreshes its license JWT when this changes.
 *
 * Idempotent — always increments by 1; callers do not need to compare.
 */
export async function bumpLicenseVersion(userId: string): Promise<number> {
  const rows = await db<{ license_version: number }[]>`
    UPDATE users
    SET license_version = license_version + 1
    WHERE id = ${userId}
    RETURNING license_version
  `;
  return rows[0]?.license_version ?? 0;
}

export async function getHeartbeat(userId: string): Promise<{
  revoked: boolean;
  licenseVersion: number;
  lastRevokedAt: string | null;
}> {
  // licenseVersion is sourced from users.license_version (monotonic per user).
  // "revoked" is true iff the user has at least one license row AND every
  // non-deleted license row has a revoked_at timestamp set. This matches the
  // semantics of revokeDevice({ userId }) which revokes ALL devices for the user.
  // If the user has no licenses at all (never validated), revoked=false — they
  // simply don't have a license to revoke.
  const rows = await db<
    { license_version: number; total: string; active: string; last_revoked_at: string | null }[]
  >`
    SELECT
      u.license_version,
      COUNT(l.id)::text                                      AS total,
      COUNT(l.id) FILTER (WHERE l.revoked_at IS NULL)::text  AS active,
      MAX(l.revoked_at)                                      AS last_revoked_at
    FROM users u
    LEFT JOIN licenses l ON l.user_id = u.id
    WHERE u.id = ${userId}
    GROUP BY u.license_version
  `;
  const row = rows[0];
  if (!row) {
    return { revoked: false, licenseVersion: 0, lastRevokedAt: null };
  }
  const total = Number(row.total);
  const active = Number(row.active);
  const revoked = total > 0 && active === 0;
  return {
    revoked,
    licenseVersion: row.license_version,
    lastRevokedAt: row.last_revoked_at
      ? new Date(row.last_revoked_at).toISOString()
      : null,
  };
}

export async function validateAndIssueLicense(opts: {
  userId: string;
  deviceId: string;
  extensionVersion?: string;
}): Promise<{ licenseJwt: string; publicKeyId: string; expiresAt: string }> {
  const subs = await db`
    SELECT id, tier, status, grace_until
    FROM subscriptions
    WHERE user_id = ${opts.userId}
      AND status IN ('active', 'trialing', 'past_due')
    ORDER BY created_at DESC LIMIT 1
  `;

  const tier = subs.length > 0 ? subs[0].tier : 'free_trial';
  const subscriptionId = subs.length > 0 ? subs[0].id : null;
  const paymentPastDue = subs.length > 0
    && subs[0].status === 'past_due'
    && subs[0].grace_until
    && new Date(subs[0].grace_until) > new Date();
  const features = featuresForTier(tier);

  const revoked = await db`
    SELECT id FROM licenses
    WHERE user_id = ${opts.userId} AND device_id = ${opts.deviceId} AND revoked_at IS NOT NULL
  `;
  if (revoked.length > 0) throw forbidden('This device has been revoked');

  const now = new Date();
  await db`
    INSERT INTO licenses (user_id, subscription_id, device_id, last_jwt_issued_at, last_seen_at)
    VALUES (${opts.userId}, ${subscriptionId}, ${opts.deviceId}, ${now}, ${now})
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      subscription_id = ${subscriptionId},
      last_jwt_issued_at = ${now},
      last_seen_at = ${now}
  `;

  await db`
    INSERT INTO audit_log (user_id, action, subject, metadata)
    VALUES (
      ${opts.userId}, 'license.issued', ${opts.deviceId},
      ${db.json({ tier, extensionVersion: opts.extensionVersion ?? 'unknown' })}
    )
  `;

  // NOTE: We intentionally do NOT bump license_version here. Routine validate
  // calls happen on every JWT refresh (every ~6h or sooner). Bumping on validate
  // creates a heartbeat→version-mismatch→force-refresh→validate→bump loop where
  // every poll sees a new version and force-refreshes again. Version is bumped
  // only on grant, revoke, Stripe sub create/update/delete, and admin tier change.

  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const licenseJwt = await signLicenseJwt({
    sub: opts.userId,
    device: opts.deviceId,
    tier,
    features,
    paymentPastDue: paymentPastDue ?? false,
  });

  return {
    licenseJwt,
    publicKeyId: config.JWT_PUBLIC_KEY_ID,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function getDevices(userId: string): Promise<object[]> {
  const rows = await db`
    SELECT id, device_id, last_jwt_issued_at, last_seen_at, revoked_at, created_at
    FROM licenses WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return rows as unknown as object[];
}

export async function revokeDevice(opts: {
  userId: string;
  deviceId?: string;
}): Promise<void> {
  if (opts.deviceId) {
    await db`
      UPDATE licenses SET revoked_at = now()
      WHERE user_id = ${opts.userId} AND device_id = ${opts.deviceId}
    `;
  } else {
    await db`UPDATE licenses SET revoked_at = now() WHERE user_id = ${opts.userId}`;
    // Cancel manual subscriptions so reinstalling with a new deviceId can't get a fresh JWT.
    // Real Stripe subscriptions are not touched here — use the cancel-subscription admin endpoint for those.
    await db`
      UPDATE subscriptions
      SET status = 'canceled', updated_at = now()
      WHERE user_id = ${opts.userId}
        AND status IN ('active', 'trialing', 'past_due')
        AND stripe_subscription_id LIKE 'manual_%'
    `;
  }

  await db`
    INSERT INTO audit_log (user_id, action, subject)
    VALUES (${opts.userId}, 'license.revoked', ${opts.deviceId ?? 'all'})
  `;

  // Bump version so the extension's next /license/heartbeat poll picks up
  // the revocation within ~60s instead of waiting for the 6h JWT TTL.
  await bumpLicenseVersion(opts.userId);
}
