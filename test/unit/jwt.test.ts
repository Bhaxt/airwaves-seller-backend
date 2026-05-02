import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('EdDSA');
const privPem = await exportPKCS8(privateKey);
const pubPem = await exportSPKI(publicKey);
const pubBody = pubPem
  .replace(/-----BEGIN PUBLIC KEY-----/, '')
  .replace(/-----END PUBLIC KEY-----/, '')
  .replace(/\s+/g, '');

process.env.DATABASE_URL = 'postgres://localhost:5432/none';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
process.env.RESEND_API_KEY = 're_x';
process.env.JWT_PRIVATE_KEY = privPem;
process.env.JWT_PUBLIC_KEY_ID = 'test-key';
process.env.JWT_PUBLIC_KEY_BASE64 = pubBody;
process.env.PUBLIC_URL = 'https://api.test.local';
process.env.ADMIN_SECRET = 'test-admin';
process.env.NODE_ENV = 'test';

const jwt = await import('../../src/lib/jwt.js');

describe('jwt', () => {
  it('signs and verifies an access token', async () => {
    const token = await jwt.signAccessToken({
      sub: 'user-123',
      email: 'a@b.com',
      tier: 'pro',
      features: ['bump', 'follow'],
    });
    const claims = await jwt.verifyAccessToken(token);
    expect(claims.sub).toBe('user-123');
    expect(claims.email).toBe('a@b.com');
    expect(claims.tier).toBe('pro');
    expect(claims.features).toEqual(['bump', 'follow']);
  });

  it('signs a license JWT with correct claims', async () => {
    const token = await jwt.signLicenseJwt({
      sub: 'user-456',
      device: 'device-abc',
      tier: 'pro_plus',
      features: ['bump', 'follow', 'message', 'stealth', 'relist'],
      paymentPastDue: false,
    });
    const claims = await jwt.verifyLicenseJwt(token);
    expect(claims.sub).toBe('user-456');
    expect(claims.device).toBe('device-abc');
    expect(claims.tier).toBe('pro_plus');
    expect(claims.features).toEqual(['bump', 'follow', 'message', 'stealth', 'relist']);
    expect(claims.offline_grace_seconds).toBe(259200);
    expect(claims.payment_past_due).toBe(false);
  });

  it('marks payment_past_due correctly', async () => {
    const token = await jwt.signLicenseJwt({
      sub: 'u',
      device: 'd',
      tier: 'basic',
      features: ['bump', 'follow'],
      paymentPastDue: true,
    });
    const claims = await jwt.verifyLicenseJwt(token);
    expect(claims.payment_past_due).toBe(true);
  });
});
