import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getDevices, revokeDevice } from '../services/license-service.js';
import { getOrCreateStripeCustomer, stripe } from '../services/stripe-service.js';

function requireAdmin(request: FastifyRequest): void {
  if (request.headers['x-admin-secret'] !== config.ADMIN_SECRET) {
    throw forbidden('Admin access required');
  }
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const tierQuerySchema = z.object({
  email: z.string().email(),
});

const tierBodySchema = z.object({
  email: z.string().email(),
  tier: z.enum(['free_trial', 'basic', 'pro', 'pro_plus']),
});

const checkoutBodySchema = z.object({
  email: z.string().email(),
  priceId: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const usersRoutes: FastifyPluginAsync = async (fastify) => {
  // Register /users/tier BEFORE /:email/devices so Fastify static-route
  // preference resolves /admin/users/tier correctly.
  fastify.get('/users/tier', async (request, reply) => {
    requireAdmin(request);
    const { email } = tierQuerySchema.parse(request.query);

    const rows = await db`
      SELECT s.tier, s.status, s.current_period_end
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
        AND s.status IN ('active', 'trialing', 'past_due')
      WHERE u.email = ${email} AND u.deleted_at IS NULL
      ORDER BY s.created_at DESC
      LIMIT 1
    `;

    const row = rows[0];
    return reply.send({
      tier: row?.tier ?? 'free_trial',
      subscriptionStatus: row?.status ?? 'none',
      currentPeriodEnd: row?.current_period_end ?? null,
    });
  });

  fastify.get('/users', async (request, reply) => {
    requireAdmin(request);
    const { page, limit } = listQuerySchema.parse(request.query);
    const offset = (page - 1) * limit;

    const users = await db`
      SELECT
        u.id, u.email, u.created_at,
        s.tier, s.status as sub_status, s.current_period_end, s.cancel_at_period_end,
        COUNT(l.id) FILTER (WHERE l.revoked_at IS NULL) as device_count
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
        AND s.status != 'canceled'
        AND s.status != 'incomplete_expired'
      LEFT JOIN licenses l ON l.user_id = u.id
      WHERE u.deleted_at IS NULL
      GROUP BY u.id, u.email, u.created_at, s.tier, s.status, s.current_period_end, s.cancel_at_period_end
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const totalRows = await db`SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL`;
    const total = Number(totalRows[0]?.count ?? 0);

    return reply.send({ users, total, page, limit });
  });

  fastify.get<{ Params: { email: string } }>('/users/:email/devices', async (request, reply) => {
    requireAdmin(request);
    const email = request.params.email;

    const users = await db`
      SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL
    `;
    if (users.length === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const devices = await getDevices(users[0].id);
    return reply.send({ devices });
  });

  fastify.post('/users/tier', async (request, reply) => {
    requireAdmin(request);
    const { email, tier: newTier } = tierBodySchema.parse(request.body);

    const users = await db`
      SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL
    `;
    if (users.length === 0) {
      return reply.status(404).send({ ok: false, error: 'User not found' });
    }
    const userId = users[0].id;

    const subs = await db`
      SELECT id, tier FROM subscriptions
      WHERE user_id = ${userId}
        AND status IN ('active', 'trialing', 'past_due')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (subs.length === 0) {
      return reply.status(404).send({ ok: false, error: 'No active subscription found' });
    }

    const oldTier = subs[0].tier;
    await db`
      UPDATE subscriptions SET tier = ${newTier}, updated_at = now()
      WHERE id = ${subs[0].id}
    `;

    await db`
      INSERT INTO audit_log (user_id, action, subject, metadata)
      VALUES (${userId}, 'admin.tier_override', ${email},
        ${db.json({ tier: newTier, previousTier: oldTier })})
    `;

    logger.info({ userId, email, oldTier, newTier }, 'Admin tier override');
    return reply.send({ ok: true, tier: newTier });
  });

  fastify.post('/grant-license', async (request, reply) => {
    requireAdmin(request);
    const { email, tier } = z.object({
      email: z.string().email(),
      tier: z.enum(['basic', 'pro', 'pro_plus']).default('pro'),
    }).parse(request.body);

    const userRows = await db`
      INSERT INTO users (email) VALUES (${email})
      ON CONFLICT (email) DO UPDATE SET deleted_at = NULL
      RETURNING id
    `;
    const userId = userRows[0].id as string;

    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const manualSubId = `manual_${userId}_${Date.now()}`;

    await db`
      INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_price_id, tier, status, current_period_end, cancel_at_period_end)
      VALUES (${userId}, ${manualSubId}, 'manual', ${tier}, 'active', ${periodEnd}, false)
    `;

    // Un-revoke all existing devices so the extension can re-validate immediately
    await db`UPDATE licenses SET revoked_at = NULL WHERE user_id = ${userId}`;

    await db`
      INSERT INTO audit_log (user_id, action, subject, metadata)
      VALUES (${userId}, 'admin.grant_license', ${email}, ${db.json({ tier })})
    `;

    logger.info({ userId, email, tier }, 'Admin granted manual license');
    return reply.send({ ok: true, userId, tier, expiresAt: periodEnd.toISOString() });
  });

  fastify.post('/revoke-license', async (request, reply) => {
    requireAdmin(request);
    const { email, deviceId } = z.object({
      email: z.string().email(),
      deviceId: z.string().optional(),
    }).parse(request.body);

    const users = await db`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    if (users.length === 0) return reply.status(404).send({ ok: false, error: 'User not found' });

    const userId = users[0].id as string;
    await revokeDevice({ userId, deviceId });
    logger.info({ userId, email, deviceId }, 'Admin revoked license');
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { email: string } }>('/users/:email/licenses', async (request, reply) => {
    requireAdmin(request);
    const email = request.params.email;
    const users = await db`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    if (users.length === 0) return reply.status(404).send({ error: 'User not found' });
    const devices = await getDevices(users[0].id as string);
    return reply.send({ devices });
  });

  fastify.post('/checkout-session', async (request, reply) => {
    requireAdmin(request);
    const { email, priceId, successUrl, cancelUrl } = checkoutBodySchema.parse(request.body);

    const userRows = await db`
      INSERT INTO users (email) VALUES (${email})
      ON CONFLICT (email) DO UPDATE SET deleted_at = NULL
      RETURNING id
    `;
    const userId = userRows[0].id;

    const customerId = await getOrCreateStripeCustomer(userId, email);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      customer_update: { name: 'auto', address: 'auto' },
      metadata: { userId, adminCreated: 'true' },
    });

    return reply.send({ url: session.url });
  });
};

export default usersRoutes;
