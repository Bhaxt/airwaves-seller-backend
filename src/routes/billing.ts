import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createCheckoutSession, createPortalSession } from '../services/stripe-service.js';
import { TIERS } from '../services/tier-map.js';
import { config } from '../config.js';

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/tiers', async (_req, reply) => {
    return reply.send({ tiers: TIERS });
  });

  fastify.post('/checkout-session', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { priceId } = z.object({ priceId: z.string().min(1) }).parse(request.body);
    const url = await createCheckoutSession({
      userId: request.user!.id,
      email: request.user!.email,
      priceId,
      successUrl: `${config.PUBLIC_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.PUBLIC_URL}/billing/cancel`,
    });
    return reply.send({ url });
  });

  fastify.post('/portal-session', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const url = await createPortalSession(request.user!.id, `${config.PUBLIC_URL}/settings`);
    return reply.send({ url });
  });
};

export default billingRoutes;
