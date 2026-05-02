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
});
