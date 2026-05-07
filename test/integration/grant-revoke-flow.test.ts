import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootstrapTestEnv, type TestEnv } from './_setup.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof import('../../src/app.js')['buildApp']>>;
let verifyLicenseJwt: typeof import('../../src/lib/jwt.js')['verifyLicenseJwt'];

async function loginAndGetAccessToken(email: string): Promise<string> {
  const loginRes = await app.inject({
    method: 'POST', url: '/auth/login?client=ext', payload: { email },
  });
  const { devToken } = JSON.parse(loginRes.body);
  const verifyRes = await app.inject({ method: 'GET', url: `/auth/verify?token=${devToken}&client=ext` });
  return JSON.parse(verifyRes.body).accessToken;
}

beforeAll(async () => {
  env = await bootstrapTestEnv();

  vi.mock('resend', () => ({
    Resend: class { emails = { send: async () => ({ data: { id: 'mock' }, error: null }) }; },
  }));

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();

  const jwt = await import('../../src/lib/jwt.js');
  verifyLicenseJwt = jwt.verifyLicenseJwt;
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await env?.container?.stop();
});

describe('grant → heartbeat → validate → revoke → heartbeat → validate flow', () => {
  it('full end-to-end grant and revoke cycle with heartbeat version tracking', async () => {
    const email = 'grant-revoke-e2e@example.com';
    const deviceId = 'ext-device-e2e-001';

    // Step 1 & 2: Create user via magic-link bypass and get access token.
    // loginAndGetAccessToken hits /auth/login (creates user) then /auth/verify.
    const accessToken = await loginAndGetAccessToken(email);
    expect(accessToken).toBeTruthy();

    // Step 3: Snapshot heartbeat — fresh user has licenseVersion 0, revoked false.
    const hb0Res = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(hb0Res.statusCode).toBe(200);
    const hb0 = JSON.parse(hb0Res.body);
    expect(hb0.revoked).toBe(false);
    expect(hb0.licenseVersion).toBe(0);

    // Step 4: Admin grants a 30-day pro license for this user.
    const grantRes = await app.inject({
      method: 'POST',
      url: '/admin/grant-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email, tier: 'pro' },
    });
    expect(grantRes.statusCode).toBe(200);
    const { userId } = JSON.parse(grantRes.body);
    expect(userId).toBeTruthy();

    // Step 5: Extension calls heartbeat — licenseVersion must have incremented (0 → ≥1).
    const hb1Res = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(hb1Res.statusCode).toBe(200);
    const hb1 = JSON.parse(hb1Res.body);
    expect(hb1.revoked).toBe(false);
    expect(hb1.licenseVersion).toBeGreaterThan(hb0.licenseVersion);
    const versionAfterGrant = hb1.licenseVersion;

    // Step 6: Extension calls /license/validate — should return a valid JWT.
    const validateRes = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId, extensionVersion: '1.0.0' },
    });
    expect(validateRes.statusCode).toBe(200);
    const { licenseJwt, publicKeyId } = JSON.parse(validateRes.body);
    expect(licenseJwt).toBeTruthy();
    expect(publicKeyId).toBe('test-key');

    // Step 7: Verify JWT signature, issuer, audience, exp, and tier claims.
    const claims = await verifyLicenseJwt(licenseJwt);
    // verifyLicenseJwt internally asserts issuer=PUBLIC_URL and audience='airwaves-extension';
    // if either is wrong it throws — reaching here means both are correct.
    expect(claims.sub).toBe(userId);
    expect(claims.device).toBe(deviceId);
    expect(claims.tier).toBe('pro');
    expect(claims.features).toContain('bump');
    expect(claims.payment_past_due).toBe(false);
    // exp: verifyLicenseJwt would throw if expired; confirm offline_grace_seconds is present.
    expect(claims.offline_grace_seconds).toBeGreaterThan(0);

    // Step 8: Admin POST /admin/revoke-license with email only (no deviceId — revoke all).
    const revokeRes = await app.inject({
      method: 'POST',
      url: '/admin/revoke-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email },
    });
    expect(revokeRes.statusCode).toBe(200);

    // Step 9: Extension calls heartbeat — revoked must be true, licenseVersion incremented again.
    const hb2Res = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(hb2Res.statusCode).toBe(200);
    const hb2 = JSON.parse(hb2Res.body);
    expect(hb2.revoked).toBe(true);
    expect(hb2.lastRevokedAt).toBeTruthy();
    expect(hb2.licenseVersion).toBeGreaterThan(versionAfterGrant);

    // Step 10: Extension calls /license/validate — must return 403 (no active license).
    const validateAfterRevoke = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId, extensionVersion: '1.0.0' },
    });
    expect(validateAfterRevoke.statusCode).toBe(403);
  });
});
