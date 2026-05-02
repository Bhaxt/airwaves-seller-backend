import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Stripe from 'stripe';
import { bootstrapTestEnv, type TestEnv } from './_setup.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof import('../../src/app.js')['buildApp']>>;
let db: import('postgres').Sql;
const WEBHOOK_SECRET = 'whsec_test_secret_xxxxxxxxxxxxxxxx';

function signedRequest(payloadObj: object) {
  const payload = JSON.stringify(payloadObj);
  const stripeStub = new Stripe('sk_test_x', { apiVersion: '2024-04-10' });
  const header = stripeStub.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, header };
}

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

  await db`INSERT INTO users (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'wh@example.com')`;
  await db`INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ('11111111-1111-1111-1111-111111111111', 'cus_test_001')`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await env?.container?.stop();
});

describe('stripe webhook', () => {
  it('rejects unsigned requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('processes customer.subscription.created and stores tier', async () => {
    const evt = {
      id: 'evt_sub_created_1',
      object: 'event',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_test_001',
          customer: 'cus_test_001',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          cancel_at_period_end: false,
          items: {
            data: [
              { price: { id: 'price_basic_monthly', lookup_key: 'basic_monthly' } },
            ],
          },
        },
      },
    };
    const { payload, header } = signedRequest(evt);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const subs = await db`SELECT tier, status FROM subscriptions WHERE stripe_subscription_id = 'sub_test_001'`;
    expect(subs.length).toBe(1);
    expect(subs[0].tier).toBe('basic');
    expect(subs[0].status).toBe('active');
  });

  it('is idempotent for duplicate event ids', async () => {
    const evt = {
      id: 'evt_dup_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_001',
          customer: 'cus_test_001',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_basic_monthly', lookup_key: 'basic_monthly' } }] },
        },
      },
    };
    const a = signedRequest(evt);
    const r1 = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': a.header },
      payload: a.payload,
    });
    expect(r1.statusCode).toBe(200);

    const b = signedRequest(evt);
    const r2 = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': b.header },
      payload: b.payload,
    });
    expect(r2.statusCode).toBe(200);

    const events = await db`SELECT COUNT(*)::int AS n FROM webhook_events WHERE id = 'evt_dup_1'`;
    expect(events[0].n).toBe(1);
  });

  it('invoice.payment_failed sets grace_until ~7 days out', async () => {
    const evt = {
      id: 'evt_failed_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: { id: 'in_test_1', customer: 'cus_test_001', subscription: 'sub_test_001' },
      },
    };
    const { payload, header } = signedRequest(evt);
    const res = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const subs = await db`SELECT status, grace_until FROM subscriptions WHERE stripe_subscription_id = 'sub_test_001'`;
    expect(subs[0].status).toBe('past_due');
    const graceMs = new Date(subs[0].grace_until).getTime() - Date.now();
    expect(graceMs).toBeGreaterThan(6 * 86400_000);
    expect(graceMs).toBeLessThan(8 * 86400_000);
  });

  it('invoice.payment_succeeded clears grace_until', async () => {
    const evt = {
      id: 'evt_succeeded_1',
      object: 'event',
      type: 'invoice.payment_succeeded',
      data: {
        object: { id: 'in_test_2', customer: 'cus_test_001', subscription: 'sub_test_001' },
      },
    };
    const { payload, header } = signedRequest(evt);
    const res = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const subs = await db`SELECT status, grace_until FROM subscriptions WHERE stripe_subscription_id = 'sub_test_001'`;
    expect(subs[0].status).toBe('active');
    expect(subs[0].grace_until).toBeNull();
  });
});
