import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import dbPlugin from './plugins/db-plugin.js';
import authPlugin from './plugins/auth-plugin.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import licenseRoutes from './routes/license.js';
import billingRoutes from './routes/billing.js';
import webhookRoutes from './routes/webhooks.js';
import './types/index.js';

export async function buildApp() {
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || origin.startsWith('chrome-extension://') || origin === config.PUBLIC_URL) {
        callback(null, true);
      } else {
        callback(new Error('CORS'));
      }
    }
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(dbPlugin);
  await app.register(authPlugin);

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: '/auth' });
  app.register(licenseRoutes, { prefix: '/license' });
  app.register(billingRoutes, { prefix: '/billing' });
  // Webhook plugin installs its own raw-body content-type parser; isolated by Fastify's encapsulation.
  app.register(webhookRoutes, { prefix: '/webhooks' });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: 'Validation error', details: (err as { validation: unknown }).validation });
    }
    logger.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  return app;
}
