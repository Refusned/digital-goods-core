import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../src/db.js';
import { config } from '../src/config.js';

const catalog = JSON.parse(readFileSync(join(config.root, 'db/data/catalog.json'), 'utf8'));
const keyPool = JSON.parse(readFileSync(join(config.root, 'db/data/keys.json'), 'utf8'));

const reset = process.argv.includes('--reset');
if (reset) {
  await pool.query(`TRUNCATE deliveries, supplier_requests, ledger_entries, payment_events, orders RESTART IDENTITY CASCADE`);
  await pool.query('TRUNCATE supplier_stub.issued');
  await pool.query('TRUNCATE supplier_stub.keys RESTART IDENTITY');
}

// Каталог. Популярность задаём убывающей по порядку из задания: витрине нужен стабильный ключ сортировки.
let popularity = catalog.products.length;
for (const p of catalog.products) {
  await pool.query(
    `INSERT INTO products (sku, name, type, price_minor, currency, image, popularity)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (sku) DO UPDATE
        SET name = EXCLUDED.name, type = EXCLUDED.type, price_minor = EXCLUDED.price_minor,
            currency = EXCLUDED.currency, image = EXCLUDED.image`,
    [p.sku, p.name, p.type, p.price, p.currency, p.image, popularity--],
  );
}

// Пул ключей раскладываем по товарам и делим между двумя независимыми поставщиками:
// у каждого поставщика свой склад, один код принадлежит ровно одному складу и одному SKU.
const skus = catalog.products.map((p) => p.sku);
for (const [idx, code] of keyPool.keys.entries()) {
  const supplier = idx % 2 === 0 ? 'A' : 'B';
  const sku = skus[idx % skus.length];
  await pool.query(
    `INSERT INTO supplier_stub.keys (supplier, sku, code) VALUES ($1, $2, $3)
     ON CONFLICT (supplier, code) DO NOTHING`,
    [supplier, sku, code],
  );
}

// Витрина это проекция складов поставщиков, а не отдельная выдумка.
await pool.query(
  `INSERT INTO product_stock (sku, available)
   SELECT p.sku, COALESCE(k.free, 0)
     FROM products p
     LEFT JOIN (SELECT sku, count(*) FILTER (WHERE taken_by IS NULL)::int AS free
                  FROM supplier_stub.keys GROUP BY sku) k ON k.sku = p.sku
   ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
);

const counts = await pool.query(
  `SELECT (SELECT count(*) FROM products) AS products,
          (SELECT count(*) FROM supplier_stub.keys WHERE supplier = 'A') AS keys_a,
          (SELECT count(*) FROM supplier_stub.keys WHERE supplier = 'B') AS keys_b`,
);
process.stdout.write(`seed: ${JSON.stringify(counts.rows[0])}\n`);
await closePool();
