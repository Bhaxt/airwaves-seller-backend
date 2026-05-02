import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { signAccessToken, verifyAccessToken } from './lib/jwt.js';

async function jwtSelfTest(): Promise<void> {
  try {
    const tok = await signAccessToken({
      sub: 'self-test',
      email: 'self-test@local',
      tier: 'free_trial',
      features: [],
    });
    const decoded = await verifyAccessToken(tok);
    if (decoded.sub !== 'self-test') {
      throw new Error('JWT self-test mismatch');
    }
    logger.info('JWT self-test passed');
  } catch (e) {
    logger.fatal({ err: (e as Error).message }, 'JWT_SELF_TEST_FAILED');
    process.exit(1);
  }
}

async function waitForDb(maxAttempts = 10, delayMs = 3000): Promise<void> {
  const { db } = await import('./db/client.js');
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await db`SELECT 1`;
      logger.info('Database connection established');
      return;
    } catch (e) {
      logger.warn({ attempt: i, maxAttempts, err: (e as Error).message }, 'DB not ready, retrying...');
      if (i === maxAttempts) {
        logger.fatal({ err: (e as Error).message }, 'DB_CONNECTION_FAILED');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  logger.info('Starting AirWaves Seller backend...');
  logger.info({ DATABASE_URL: config.DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@') }, 'Config loaded');

  await waitForDb();
  await runMigrations();
  await jwtSelfTest();
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'Server started');
}

main().catch(err => {
  logger.fatal({ err: err?.message, stack: err?.stack }, 'UNHANDLED_STARTUP_ERROR');
  console.error(err);
  process.exit(1);
});
