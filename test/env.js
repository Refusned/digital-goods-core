/**
 * Импортируется ПЕРВЫМ в каждом тестовом файле.
 *
 * Тесты чистят таблицы, поэтому в рабочую базу они не ходят вообще: здесь готовится
 * отдельная база <имя>_test, накатываются миграции, и только потом загружается остальной код.
 * Так `npm test` работает сразу после `docker compose up -d` и не может стереть чужие данные.
 */
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.WORKER_ENABLED = '0';                  // воркер тесты поднимают точечно
process.env.SUPPLIER_TIMEOUT_MS = '400';
process.env.SUPPLIER_MAX_ATTEMPTS = '3';
process.env.SUPPLIER_BACKOFF_BASE_MS = '50';
process.env.OUT_OF_STOCK_RETRY_MS = '250';

const baseUrl = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop';

function testUrlFrom(url) {
  if (process.env.TEST_DATABASE_URL) return new URL(process.env.TEST_DATABASE_URL);
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '') || 'shop';
  parsed.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return parsed;
}

const testUrl = testUrlFrom(baseUrl);
const testDbName = testUrl.pathname.replace(/^\//, '');

// Создаём тестовую базу, если её ещё нет.
const adminUrl = new URL(testUrl);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDbName]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${testDbName}"`);
await admin.end();

// Накатываем схему.
const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const db = new pg.Client({ connectionString: testUrl.toString() });
await db.connect();
for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
  await db.query(readFileSync(join(migrations, file), 'utf8'));
}
await db.end();

process.env.DATABASE_URL = testUrl.toString();
