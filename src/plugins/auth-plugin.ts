import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { errors } from 'jose';
import { verifyAccessToken } from '../lib/jwt.js';

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      const code = 'MISSING_AUTH_HEADER';
      request.log.warn({ code, path: request.url, ip: request.ip }, 'auth_failed');
      return reply.status(401).send({ error: 'Unauthorized', code });
    }
    const token = authHeader.slice(7);
    try {
      const payload = await verifyAccessToken(token);
      request.user = {
        id: payload.sub,
        email: payload.email,
        tier: payload.tier,
        features: payload.features,
      };
    } catch (e) {
      let code: 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'WRONG_ISSUER' = 'INVALID_TOKEN';
      if (e instanceof errors.JWTExpired) code = 'EXPIRED_TOKEN';
      else if (e instanceof errors.JWTClaimValidationFailed) code = 'WRONG_ISSUER';
      else if (e instanceof errors.JWSSignatureVerificationFailed) code = 'INVALID_TOKEN';
      else if (e instanceof errors.JWSInvalid) code = 'INVALID_TOKEN';
      request.log.warn({ code, path: request.url, ip: request.ip }, 'auth_failed');
      return reply.status(401).send({ error: 'Unauthorized', code });
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
