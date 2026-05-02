import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('db', db);
  fastify.addHook('onClose', async () => {
    await db.end();
  });
};

export default fp(dbPlugin, { name: 'db' });
