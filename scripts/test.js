/**
 * Запуск тестов.
 *
 * Тесты чистят таблицы, поэтому рабочая база им не показывается вообще: здесь готовится
 * отдельная база <имя>_test, накатываются миграции, и только после этого запускается node --test
 * с уже подготовленным окружением.
 *
 * Почему отдельным процессом, а не подготовкой внутри тестового файла: статические импорты ESM
 * выполняются раньше, чем завершается top-level await соседнего модуля, поэтому подмена
 * DATABASE_URL "перед импортами" не работает. Переменная должна существовать до старта процесса.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../src/config.js';
import { applyMigrations } from './lib/migrations.js';

const baseUrl = process.env.DATABASE_URL || config.databaseUrl || 'postgres://shop:shop@localhost:5442/shop';

function testUrlFrom(url) {
  if (process.env.TEST_DATABASE_URL) return new URL(process.env.TEST_DATABASE_URL);
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '') || 'shop';
  parsed.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return parsed;
}

const testUrl = testUrlFrom(baseUrl);
const testDbName = testUrl.pathname.replace(/^\//, '');

const adminUrl = new URL(testUrl);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDbName]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE "${testDbName}"`);
  process.stdout.write(`тестовая база создана: ${testDbName}\n`);
}
await admin.end();

const db = new pg.Client({ connectionString: testUrl.toString() });
await db.connect();
await applyMigrations(db, join(config.root, 'db', 'migrations'));
await db.end();

const files = readdirSync(join(config.root, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join('test', f));

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: testUrl.toString(),
    TEST_DATABASE_URL: testUrl.toString(),
    ALLOW_DESTRUCTIVE_TESTS: '1',
  },
});
process.exit(result.status ?? 1);
