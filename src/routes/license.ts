import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { validateAndIssueLicense, getDevices, revokeDevice } from '../services/license-service.js';
import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';

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

  fastify.post('/revoke', async (request, reply) => {
    const adminSecret = request.headers['x-admin-secret'];
    if (adminSecret !== config.ADMIN_SECRET) throw forbidden('Admin access required');

    const { userId, deviceId } = z.object({
      userId: z.string().uuid(),
      deviceId: z.string().optional(),
    }).parse(request.body);

    await revokeDevice({ userId, deviceId });
    return reply.send({ ok: true });
  });
};

export default licenseRoutes;
