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

describe('license flow', () => {
  it('POST /license/validate issues a license JWT for free_trial', async () => {
    const accessToken = await loginAndGetAccessToken('lic@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'device-1', extensionVersion: '0.1.0' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.licenseJwt).toBeDefined();
    expect(body.publicKeyId).toBe('test-key');

    const claims = await verifyLicenseJwt(body.licenseJwt);
    expect(claims.tier).toBe('free_trial');
    expect(claims.device).toBe('device-1');
    expect(claims.features).toEqual(['bump']);
    expect(claims.payment_past_due).toBe(false);
  });

  it('GET /license/devices lists devices', async () => {
    const accessToken = await loginAndGetAccessToken('devs@example.com');
    await app.inject({
      method: 'POST', url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'd-A' },
    });
    await app.inject({
      method: 'POST', url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'd-B' },
    });
    const res = await app.inject({
      method: 'GET', url: '/license/devices',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.devices.length).toBe(2);
  });

  it('POST /license/validate returns 403 for revoked device', async () => {
    const accessToken = await loginAndGetAccessToken('rev@example.com');
    const meRes = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const userId = JSON.parse(meRes.body).id;

    await app.inject({
      method: 'POST', url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'doomed' },
    });

    const revRes = await app.inject({
      method: 'POST',
      url: '/license/revoke',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { userId, deviceId: 'doomed' },
    });
    expect(revRes.statusCode).toBe(200);

    const reissue = await app.inject({
      method: 'POST', url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'doomed' },
    });
    expect(reissue.statusCode).toBe(403);
  });

  it('rejects /license/revoke without admin secret', async () => {
    const res = await app.inject({
      method: 'POST', url: '/license/revoke',
      payload: { userId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('revoke then re-grant cycle', async () => {
    const email = 'revoke-regrant@example.com';
    const deviceId = 'test-device-revoke-001';

    // Grant a manual subscription
    const grantRes = await app.inject({
      method: 'POST',
      url: '/admin/grant-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email, tier: 'pro' },
    });
    expect(grantRes.statusCode).toBe(200);
    const { userId } = JSON.parse(grantRes.body);

    const accessToken = await loginAndGetAccessToken(email);

    // Validate — should succeed and issue a pro JWT
    const validate1 = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId },
    });
    expect(validate1.statusCode).toBe(200);
    const claims1 = await verifyLicenseJwt(JSON.parse(validate1.body).licenseJwt);
    expect(claims1.tier).toBe('pro');

    // Revoke that specific device
    const revokeRes = await app.inject({
      method: 'POST',
      url: '/license/revoke',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { userId, deviceId },
    });
    expect(revokeRes.statusCode).toBe(200);

    // Validate after revoke — should be blocked
    const validate2 = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId },
    });
    expect(validate2.statusCode).toBe(403);

    // Re-grant (un-revokes devices and restores active subscription)
    const regrantRes = await app.inject({
      method: 'POST',
      url: '/admin/grant-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email, tier: 'pro' },
    });
    expect(regrantRes.statusCode).toBe(200);

    // Validate after re-grant — should succeed again
    const validate3 = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId },
    });
    expect(validate3.statusCode).toBe(200);
    const claims3 = await verifyLicenseJwt(JSON.parse(validate3.body).licenseJwt);
    expect(claims3.tier).toBe('pro');
  });

  it('GET /license/heartbeat returns version 0 + revoked:false for fresh user', async () => {
    const accessToken = await loginAndGetAccessToken('hb-fresh@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.revoked).toBe(false);
    expect(body.licenseVersion).toBe(0);
    expect(body.lastRevokedAt).toBeNull();
  });

  it('GET /license/heartbeat requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/license/heartbeat' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /license/heartbeat: licenseVersion bumps on revoke and grant (NOT validate)', async () => {
    const email = 'hb-bump@example.com';
    const deviceId = 'hb-device-1';

    // Grant a license to create a user with subscription.
    await app.inject({
      method: 'POST',
      url: '/admin/grant-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email, tier: 'pro' },
    });

    const accessToken = await loginAndGetAccessToken(email);

    // Initial heartbeat — version reflects the grant (>= 1).
    const hb0 = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const v0 = JSON.parse(hb0.body).licenseVersion;
    expect(v0).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(hb0.body).revoked).toBe(false);

    // Validate (issues a JWT) — must NOT bump version. Routine validate calls
    // are idempotent w.r.t. version; otherwise a heartbeat-induced refresh
    // would loop (mismatch → refresh → validate → bump → mismatch).
    await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId },
    });
    const hb1 = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const v1 = JSON.parse(hb1.body).licenseVersion;
    expect(v1).toBe(v0);
    expect(JSON.parse(hb1.body).revoked).toBe(false);

    // Revoke all — bumps version AND should now report revoked:true.
    await app.inject({
      method: 'POST',
      url: '/admin/revoke-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email },
    });
    const hb2 = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body2 = JSON.parse(hb2.body);
    expect(body2.licenseVersion).toBeGreaterThan(v1);
    expect(body2.revoked).toBe(true);
    expect(body2.lastRevokedAt).toBeTruthy();

    // Re-grant — bumps version, un-revokes (revoked back to false).
    await app.inject({
      method: 'POST',
      url: '/admin/grant-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email, tier: 'pro' },
    });
    const hb3 = await app.inject({
      method: 'GET',
      url: '/license/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body3 = JSON.parse(hb3.body);
    expect(body3.licenseVersion).toBeGreaterThan(body2.licenseVersion);
    expect(body3.revoked).toBe(false);
  });

  it('revoke-all does not allow new device to revalidate', async () => {
    // Verifies Gap 3 fix — revoke-all now cancels subscription, blocking new devices.
    const email = 'revoke-all-gap3@example.com';

    // Grant a manual subscription
    const grantRes = await app.inject({
      method: 'POST',
      url: '/admin/grant-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email, tier: 'pro' },
    });
    expect(grantRes.statusCode).toBe(200);

    const accessToken = await loginAndGetAccessToken(email);

    // Validate with device A to register the device
    const validate1 = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'test-device-A' },
    });
    expect(validate1.statusCode).toBe(200);

    // Revoke all (no deviceId) — also cancels the manual subscription
    const revokeAllRes = await app.inject({
      method: 'POST',
      url: '/admin/revoke-license',
      headers: { 'x-admin-secret': 'test-admin' },
      payload: { email },
    });
    expect(revokeAllRes.statusCode).toBe(200);

    // Validate with a brand-new device B — must be blocked because the subscription
    // was canceled by revoke-all (Gap 3 fix); a fresh device has no revoked_at row
    // but the subscription is gone, so validate falls back to free_trial.
    // The route should return 403 because the subscription is canceled.
    const validate2 = await app.inject({
      method: 'POST',
      url: '/license/validate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: 'test-device-B' },
    });
    expect(validate2.statusCode).toBe(403);
  });
});
