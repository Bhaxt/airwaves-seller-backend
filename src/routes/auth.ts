import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  initiateLogin, verifyMagicLink, verifyMagicLinkCode, refreshSession, revokeSession, getMe,
} from '../services/auth-service.js';
import { checkAuthRateLimit } from '../lib/rate-limit.js';
import { config } from '../config.js';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const loginBody = z.object({ email: z.string().email() });
  const verifyCodeBody = z.object({
    email: z.string().email(),
    code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  });
  const refreshBody = z.object({ refreshToken: z.string().min(1) });
  const logoutBody = z.object({ refreshToken: z.string().min(1) });

  async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
    const { email } = loginBody.parse(request.body);
    checkAuthRateLimit(email);
    const result = await initiateLogin({
      email,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      clientType: ((request.query as Record<string, string>)?.client) ?? 'ext',
    });
    const body: Record<string, unknown> = { message: 'Check your email for a sign-in link' };
    if (result.devToken) body.devToken = result.devToken;
    return reply.status(202).send(body);
  }

  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: 60 * 1000 } } };

  fastify.post('/login', authRateLimit, loginHandler);
  fastify.post('/register', authRateLimit, loginHandler);

  fastify.get('/verify', async (request, reply) => {
    const { token, client } = request.query as { token?: string; client?: string };
    if (!token) return reply.status(400).send({ error: 'token required' });

    const { user, tokens } = await verifyMagicLink({
      token,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (client === 'ext') {
      return reply.send({ ...tokens, user: { id: user.id, email: user.email } });
    }
    return reply.redirect(
      `${config.PUBLIC_URL}/ext-callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`,
    );
  });

  fastify.post('/verify-code', authRateLimit, async (request, reply) => {
    const { email, code } = verifyCodeBody.parse(request.body);
    const { user, tokens } = await verifyMagicLinkCode({
      email,
      code,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return reply.send({ ...tokens, user: { id: user.id, email: user.email } });
  });

  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = refreshBody.parse(request.body);
    const tokens = await refreshSession({
      refreshToken,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return reply.send(tokens);
  });

  fastify.post('/logout', async (request, reply) => {
    const { refreshToken } = logoutBody.parse(request.body);
    await revokeSession(refreshToken);
    return reply.send({ ok: true });
  });

  fastify.get('/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const me = await getMe(request.user!.id);
    return reply.send(me);
  });
};

export default authRoutes;
