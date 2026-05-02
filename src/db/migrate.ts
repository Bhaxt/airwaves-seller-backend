import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    const applied = await db`
      SELECT 1 FROM schema_migrations WHERE filename = ${filename}
    `;
    if (applied.length > 0) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    console.log(`Applying migration: ${filename}`);
    await db.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
    });
    console.log(`Applied: ${filename}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => { console.log('Migrations complete'); process.exit(0); })
    .catch(err => { console.error(err); process.exit(1); });
}
