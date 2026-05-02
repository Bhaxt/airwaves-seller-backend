import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { signAccessToken, verifyAccessToken } from './lib/jwt.js';

async function jwtSelfTest(): Promise<void> {
  const tok = await signAccessToken({
    sub: 'self-test',
    email: 'self-test@local',
    tier: 'free_trial',
    features: [],
  });
  const decoded = await verifyAccessToken(tok);
  if (decoded.sub !== 'self-test') {
    throw new Error('JWT self-test sub mismatch');
  }
  logger.info('JWT self-test passed');
}

async function waitForDb(maxAttempts = 10, delayMs = 3000): Promise<void> {
  const { db } = await import('./db/client.js');
  let lastErr: Error | null = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await db`SELECT 1`;
      logger.info('Database connection established');
      return;
    } catch (e) {
      lastErr = e as Error;
      logger.warn({ attempt: i, maxAttempts, err: (e as Error).message }, 'DB not ready, retrying...');
      if (i < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error(`DB_CONNECTION_FAILED after ${maxAttempts} attempts: ${lastErr?.message}`);
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
  const msg = err?.message ?? String(err);
  logger.fatal({ err: msg, stack: err?.stack }, 'UNHANDLED_STARTUP_ERROR');
  console.error('STARTUP FAILED:', msg);
  console.error(err?.stack ?? '');
  process.exit(1);
});
