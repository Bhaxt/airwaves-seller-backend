import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootstrapTestEnv, type TestEnv } from './_setup.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof import('../../src/app.js')['buildApp']>>;
let db: import('postgres').Sql;

beforeAll(async () => {
  env = await bootstrapTestEnv();

  vi.mock('resend', () => ({
    Resend: class { emails = { send: async () => ({ data: { id: 'mock' }, error: null }) }; },
  }));

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();

  ({ db } = await import('../../src/db/client.js'));
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await env?.container?.stop();
});

describe('auth flow', () => {
  it('POST /auth/login returns 202 and creates magic link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'flow@example.com' },
    });
    expect(res.statusCode).toBe(202);

    const links = await db`SELECT token_hash FROM magic_links ml JOIN users u ON u.id = ml.user_id WHERE u.email = 'flow@example.com'`;
    expect(links.length).toBe(1);
  });

  it('GET /auth/verify consumes magic link and returns tokens', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login?client=ext',
      payload: { email: 'verify@example.com' },
    });
    const body = JSON.parse(loginRes.body);
    expect(body.devToken).toBeDefined();

    const verifyRes = await app.inject({
      method: 'GET',
      url: `/auth/verify?token=${body.devToken}&client=ext`,
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = JSON.parse(verifyRes.body);
    expect(verifyBody.accessToken).toBeDefined();
    expect(verifyBody.refreshToken).toBeDefined();
    expect(verifyBody.user.email).toBe('verify@example.com');
  });

  it('GET /auth/me returns tier (free_trial by default)', async () => {
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login?client=ext', payload: { email: 'me@example.com' },
    });
    const { devToken } = JSON.parse(loginRes.body);
    const verifyRes = await app.inject({ method: 'GET', url: `/auth/verify?token=${devToken}&client=ext` });
    const { accessToken } = JSON.parse(verifyRes.body);

    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = JSON.parse(meRes.body);
    expect(me.email).toBe('me@example.com');
    expect(me.tier).toBe('free_trial');
    expect(me.features).toEqual(['bump']);
  });

  it('POST /auth/refresh rotates the refresh token', async () => {
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login?client=ext', payload: { email: 'refresh@example.com' },
    });
    const { devToken } = JSON.parse(loginRes.body);
    const verifyRes = await app.inject({ method: 'GET', url: `/auth/verify?token=${devToken}&client=ext` });
    const { refreshToken } = JSON.parse(verifyRes.body);

    const refRes = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken },
    });
    expect(refRes.statusCode).toBe(200);
    const refBody = JSON.parse(refRes.body);
    expect(refBody.refreshToken).toBeDefined();
    expect(refBody.refreshToken).not.toBe(refreshToken);

    const reuse = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('POST /auth/logout revokes the refresh token', async () => {
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login?client=ext', payload: { email: 'logout@example.com' },
    });
    const { devToken } = JSON.parse(loginRes.body);
    const verifyRes = await app.inject({ method: 'GET', url: `/auth/verify?token=${devToken}&client=ext` });
    const { refreshToken } = JSON.parse(verifyRes.body);

    const logoutRes = await app.inject({
      method: 'POST', url: '/auth/logout', payload: { refreshToken },
    });
    expect(logoutRes.statusCode).toBe(200);

    const refRes = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken },
    });
    expect(refRes.statusCode).toBe(401);
  });
});
