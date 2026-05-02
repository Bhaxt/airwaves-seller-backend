import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SignJWT, importPKCS8 } from 'jose';
import { bootstrapTestEnv, type TestEnv } from './_setup.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof import('../../src/app.js')['buildApp']>>;

beforeAll(async () => {
  env = await bootstrapTestEnv();

  vi.mock('resend', () => ({
    Resend: class { emails = { send: async () => ({ data: { id: 'mock' }, error: null }) }; },
  }));

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();

  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await env?.container?.stop();
});

describe('granular 401 error codes on protected route', () => {
  it('returns MISSING_AUTH_HEADER when no Authorization header is sent', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
    expect(body.code).toBe('MISSING_AUTH_HEADER');
  });

  it('returns INVALID_TOKEN for a malformed bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('returns EXPIRED_TOKEN for an expired but otherwise-valid jwt', async () => {
    const key = await importPKCS8(process.env.JWT_PRIVATE_KEY!, 'EdDSA');
    const expired = await new SignJWT({ email: 'expired@example.com', tier: 'free_trial', features: [] })
      .setProtectedHeader({ alg: 'EdDSA', kid: process.env.JWT_PUBLIC_KEY_ID! })
      .setSubject('user-expired')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .setIssuer(process.env.PUBLIC_URL!)
      .sign(key);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('EXPIRED_TOKEN');
  });

  it('returns WRONG_ISSUER when token is signed with a different issuer', async () => {
    const key = await importPKCS8(process.env.JWT_PRIVATE_KEY!, 'EdDSA');
    const wrongIssuer = await new SignJWT({ email: 'wrong@example.com', tier: 'free_trial', features: [] })
      .setProtectedHeader({ alg: 'EdDSA', kid: process.env.JWT_PUBLIC_KEY_ID! })
      .setSubject('user-wrong')
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer('https://evil.example.com')
      .sign(key);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${wrongIssuer}` },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('WRONG_ISSUER');
  });
});
