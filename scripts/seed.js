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
  await pool.query(
    `INSERT INTO product_stock (sku, available) VALUES ($1, $2)
     ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
    [p.sku, 25],
  );
}

// Пул ключей делим между двумя независимыми поставщиками.
const half = Math.ceil(keyPool.keys.length / 2);
const split = { A: keyPool.keys.slice(0, half), B: keyPool.keys.slice(half) };
for (const [supplier, codes] of Object.entries(split)) {
  for (const code of codes) {
    await pool.query(
      'INSERT INTO supplier_stub.keys (supplier, code) VALUES ($1, $2) ON CONFLICT (supplier, code) DO NOTHING',
      [supplier, code],
    );
  }
}

const counts = await pool.query(
  `SELECT (SELECT count(*) FROM products) AS products,
          (SELECT count(*) FROM supplier_stub.keys WHERE supplier = 'A') AS keys_a,
          (SELECT count(*) FROM supplier_stub.keys WHERE supplier = 'B') AS keys_b`,
);
process.stdout.write(`seed: ${JSON.stringify(counts.rows[0])}\n`);
await closePool();
