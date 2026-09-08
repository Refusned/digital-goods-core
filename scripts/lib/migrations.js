import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Применить неприменённые миграции по порядку имён.
 * Каждая миграция и запись о ней идут ОДНОЙ транзакцией: наполовину применённой миграции не бывает.
 */
export async function applyMigrations(runner, dir, log = () => {}) {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await runner.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  let applied = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) {
      log(`migrate: ${file} (уже применена)\n`);
      continue;
    }
    log(`migrate: ${file}\n`);
    const sql = readFileSync(join(dir, file), 'utf8');
    // Клиент из пула: транзакция должна идти по одному соединению.
    const client = runner.connect ? await runner.connect() : runner;
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (runner.connect) client.release();
    }
  }
  return applied;
}
