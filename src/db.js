import pg from 'pg';
import { config } from './config.js';

// Деньги приходят из БД как BIGINT. Возвращаем их числом, а не строкой:
// суммы магазина заведомо в безопасном диапазоне Number, а сравнения в коде становятся честными.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

export const query = (text, params) => pool.query(text, params);

/**
 * Транзакция. Возвращает результат колбэка, откатывает при исключении.
 * Ретрай на serialization_failure/deadlock не нужен: конкурентность разруливается
 * блокировками строк и уникальными индексами на READ COMMITTED.
 */
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (err) => err && err.code === '23505';

export async function closePool() {
  await pool.end();
}
