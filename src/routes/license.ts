import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { validateAndIssueLicense, getDevices, revokeDevice, getHeartbeat } from '../services/license-service.js';
import { forbidden } from '../lib/errors.js';
import { checkAdminSecret } from '../lib/admin-auth.js';

const licenseRoutes: FastifyPluginAsync = async (fastify) => {
  const validateBody = z.object({
    deviceId: z.string().min(1),
    extensionVersion: z.string().optional(),
  });

  fastify.post('/validate', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { deviceId, extensionVersion } = validateBody.parse(request.body);
    const result = await validateAndIssueLicense({
      userId: request.user!.id,
      deviceId,
      extensionVersion,
    });
    return reply.send(result);
  });

  fastify.get('/devices', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const devices = await getDevices(request.user!.id);
    return reply.send({ devices });
  });

  // Cheap, idempotent endpoint polled by the extension every 60s.
  // Returns the user's current license_version so the extension can decide
  // whether to force-refresh the JWT. No DB writes.
  fastify.get('/heartbeat', { preHandler: [fastify.authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const hb = await getHeartbeat(request.user!.id);
    // Tell intermediaries not to cache — this needs to reflect the latest DB state.
    reply.header('Cache-Control', 'no-store');
    return reply.send(hb);
  });

  fastify.post('/revoke', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!checkAdminSecret(request.headers['x-admin-secret'])) throw forbidden('Admin access required');

    const { userId, deviceId } = z.object({
      userId: z.string().uuid(),
      deviceId: z.string().optional(),
    }).parse(request.body);

    await revokeDevice({ userId, deviceId });
    return reply.send({ ok: true });
  });
};

export default licenseRoutes;
