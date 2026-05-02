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

async function main() {
  await runMigrations();
  await jwtSelfTest();
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'Server started');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
