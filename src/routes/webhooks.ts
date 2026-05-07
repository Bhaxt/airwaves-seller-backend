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

    // Idempotency + race protection. Three observable states for a row:
    //  (a) processed_at IS NOT NULL                       → done; reply 200
    //  (b) processing_started_at recent AND processed_at IS NULL → in-flight in
    //      a sibling worker. Reply 503 so Stripe retries later (vs. returning
    //      200 and hoping the sibling succeeds — if it fails after we ack, the
    //      event is lost).
    //  (c) processing_started_at IS NULL OR stale         → previous attempt
    //      failed; we claim it and proceed.
    const inserted = await db`
      INSERT INTO webhook_events (id, type, payload, processing_started_at)
      VALUES (
        ${event.id}, ${event.type},
        ${db.json(event.data as unknown as Parameters<typeof db.json>[0])},
        now()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    if (inserted.count === 0) {
      const rows = await db<{ processed_at: Date | null; processing_started_at: Date | null }[]>`
        SELECT processed_at, processing_started_at
        FROM webhook_events WHERE id = ${event.id}
      `;
      const row = rows[0];
      if (row?.processed_at) {
        logger.debug({ eventId: event.id }, 'Duplicate webhook event — already processed');
        return reply.send({ received: true });
      }
      const startedAt = row?.processing_started_at ? new Date(row.processing_started_at).getTime() : 0;
      const inFlight = startedAt && (Date.now() - startedAt) < 5 * 60 * 1000;
      if (inFlight) {
        logger.warn({ eventId: event.id }, 'Webhook event already in-flight — asking Stripe to retry');
        return reply.status(503).send({ error: 'Event currently processing, retry later' });
      }
      // Stale (previous attempt died, or processing_started_at NULL because
      // we cleared it on a prior failure). Claim it for a fresh attempt.
      const claimed = await db`
        UPDATE webhook_events
        SET processing_started_at = now(), error = NULL
        WHERE id = ${event.id}
          AND processed_at IS NULL
          AND (processing_started_at IS NULL OR processing_started_at < now() - interval '5 minutes')
      `;
      if (claimed.count === 0) {
        // Lost the race to another worker that just claimed it.
        return reply.status(503).send({ error: 'Event currently processing, retry later' });
      }
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
      // Release the claim so a future retry can reprocess. Do NOT delete the
      // row — keeping it preserves the error trail and prevents the original
      // "DELETE then duplicate retry" race.
      await db`
        UPDATE webhook_events
        SET error = ${msg}, processing_started_at = NULL
        WHERE id = ${event.id} AND processed_at IS NULL
      `;
      return reply.status(500).send({ error: 'Webhook processing failed' });
    }

    return reply.send({ received: true });
  });
};

export default webhookRoutes;
