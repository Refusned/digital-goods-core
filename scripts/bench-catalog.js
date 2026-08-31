/**
 * Этап 5: витрина на тысячах SKU.
 * Создаёт N товаров, прогревает статистику и печатает план и время горячего запроса.
 *
 *   node scripts/bench-catalog.js [--products 20000] [--keep]
 */
import { pool, closePool } from '../src/db.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : Number(process.argv[i + 1]);
};
const products = arg('products', 20000);
const keep = process.argv.includes('--keep');

process.stdout.write(`Готовлю ${products} SKU...\n`);
await pool.query(`DELETE FROM products WHERE sku LIKE 'BENCH-%'`);
await pool.query(
  `INSERT INTO products (sku, name, type, price_minor, currency, popularity)
   SELECT 'BENCH-' || lpad(i::text, 7, '0'), 'Товар ' || i,
          (ARRAY['topup','key','subscription','giftcard'])[1 + (i % 4)],
          100 + (i % 9000), 'RUB', (i * 7919) % 1000000
     FROM generate_series(1, $1) AS i`,
  [products],
);
await pool.query(
  `INSERT INTO product_stock (sku, available)
   SELECT sku, CASE WHEN (right(sku, 3)::int % 10) < 6 THEN 5 ELSE 0 END
     FROM products WHERE sku LIKE 'BENCH-%'
   ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available`,
);
await pool.query('ANALYZE products');
await pool.query('ANALYZE product_stock');

const HOT = `
  SELECT p.sku, p.name, p.price_minor, s.available
    FROM products p LEFT JOIN product_stock s ON s.sku = p.sku
   WHERE p.is_active AND p.in_stock AND p.type = 'key'
   ORDER BY p.popularity DESC, p.sku
   LIMIT 24`;

const explain = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${HOT}`);
process.stdout.write('\nПлан горячего запроса витрины:\n' + explain.rows.map((r) => '  ' + r['QUERY PLAN']).join('\n') + '\n');

// Замер под серией запросов.
const runs = 200;
const started = process.hrtime.bigint();
for (let i = 0; i < runs; i++) await pool.query(HOT);
const perQueryMs = Number(process.hrtime.bigint() - started) / 1e6 / runs;
process.stdout.write(`\n${runs} запросов витрины: ${perQueryMs.toFixed(3)} мс на запрос\n`);

// Для сравнения: тот же запрос, если запретить планировщику индекс.
const noIndex = await pool.query(`SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off;`).catch(() => null);
if (noIndex !== null) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL enable_indexscan = off');
  await client.query('SET LOCAL enable_bitmapscan = off');
  const seq = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${HOT}`);
  await client.query('ROLLBACK');
  client.release();
  process.stdout.write(`Без индекса (для сравнения): ${seq.rows[0]['QUERY PLAN'][0]['Execution Time'].toFixed(3)} мс\n`);
}

if (!keep) {
  await pool.query(`DELETE FROM products WHERE sku LIKE 'BENCH-%'`);
  process.stdout.write('\nТестовые SKU удалены (--keep оставит их в базе)\n');
}
await closePool();
