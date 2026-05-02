import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (_req, reply) => {
    let dbStatus = 'ok';
    try { await db`SELECT 1`; } catch { dbStatus = 'error'; }

    let version = '0.0.0';
    try {
      const pkg = JSON.parse(await readFile(join(__dirname, '../../package.json'), 'utf8'));
      version = pkg.version;
    } catch { /* ignore */ }

    return reply.send({ status: 'ok', db: dbStatus, version });
  });
};

export default healthRoutes;
