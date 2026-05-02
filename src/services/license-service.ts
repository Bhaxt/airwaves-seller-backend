import { db } from '../db/client.js';
import { signLicenseJwt } from '../lib/jwt.js';
import { featuresForTier } from './tier-map.js';
import { forbidden } from '../lib/errors.js';
import { config } from '../config.js';

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
  }

  await db`
    INSERT INTO audit_log (user_id, action, subject)
    VALUES (${opts.userId}, 'license.revoked', ${opts.deviceId ?? 'all'})
  `;
}
