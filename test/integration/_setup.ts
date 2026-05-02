import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

export interface TestEnv {
  container: StartedPostgreSqlContainer;
  databaseUrl: string;
}

export async function bootstrapTestEnv(): Promise<TestEnv> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();

  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const privPem = await exportPKCS8(privateKey);
  const pubPem = await exportSPKI(publicKey);
  const pubBody = pubPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');

  process.env.DATABASE_URL = databaseUrl;
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_xxxxxxxxxxxxxxxx';
  process.env.RESEND_API_KEY = 're_x';
  process.env.JWT_PRIVATE_KEY = privPem;
  process.env.JWT_PUBLIC_KEY_ID = 'test-key';
  process.env.JWT_PUBLIC_KEY_BASE64 = pubBody;
  process.env.PUBLIC_URL = 'https://api.test.local';
  process.env.ADMIN_SECRET = 'test-admin';
  process.env.NODE_ENV = 'test';

  return { container, databaseUrl };
}
