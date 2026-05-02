import type { FastifyPluginAsync } from 'fastify';
import { stripe, handleWebhookEvent } from '../services/stripe-service.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // Stripe signature verification REQUIRES the unmodified raw Buffer.
  // This content-type parser is scoped to the webhook plugin via Fastify encapsulation.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1048576 },
    (_req, body, done) => done(null, body),
  );

  fastify.post('/stripe', async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    if (!sig) return reply.status(400).send({ error: 'Missing Stripe-Signature header' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig as string,
        config.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.warn({ err: msg }, 'Stripe webhook signature verification failed');
      return reply.status(400).send({ error: `Webhook error: ${msg}` });
    }

    const inserted = await db`
      INSERT INTO webhook_events (id, type, payload)
      VALUES (${event.id}, ${event.type}, ${db.json(event.data as unknown as object)})
      ON CONFLICT (id) DO NOTHING
    `;

    if (inserted.count === 0) {
      logger.debug({ eventId: event.id }, 'Duplicate webhook event — skipping');
      return reply.send({ received: true });
    }

    await db`
      INSERT INTO audit_log (action, subject, metadata)
      VALUES ('webhook.received', ${event.id}, ${db.json({ type: event.type })})
    `;

    try {
      await handleWebhookEvent(event);
      await db`UPDATE webhook_events SET processed_at = now() WHERE id = ${event.id}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error({ err: msg, eventId: event.id }, 'Webhook processing failed');
      await db`UPDATE webhook_events SET error = ${msg} WHERE id = ${event.id}`;
      return reply.status(500).send({ error: 'Webhook processing failed' });
    }

    return reply.send({ received: true });
  });
};

export default webhookRoutes;
