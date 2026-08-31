import './env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, pool } from './helpers.js';

let stack, http;

before(async () => {
  stack = await startStack();
  http = api(stack.base);
  await resetData();
  await seedManyProducts(5000);
});
after(async () => {
  await pool.query(`DELETE FROM products WHERE sku LIKE 'BULK-%'`);
  await stack.stop();
  await pool.end();
});

/** Тысячи SKU: 40% без остатка, чтобы витрина реально отсеивала. */
async function seedManyProducts(n) {
  await pool.query(`DELETE FROM products WHERE sku LIKE 'BULK-%'`);
  await pool.query(
    `INSERT INTO products (sku, name, type, price_minor, currency, popularity)
     SELECT 'BULK-' || lpad(i::text, 6, '0'),
            'Товар ' || i,
            (ARRAY['topup','key','subscription','giftcard'])[1 + (i % 4)],
            100 + (i % 5000),
            'RUB',
            (i * 7919) % 100000
       FROM generate_series(1, $1) AS i`,
    [n],
  );
  await pool.query(
    `INSERT INTO product_stock (sku, available)
     SELECT sku, CASE WHEN (right(sku, 3)::int % 10) < 6 THEN 5 ELSE 0 END
       FROM products WHERE sku LIKE 'BULK-%'
     ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available`,
  );
  await pool.query('ANALYZE products');
  await pool.query('ANALYZE product_stock');
}

test('витрина отдаёт только активные товары в наличии', async () => {
  const { body } = await http.get('/catalog?limit=24');
  assert.equal(body.items.length, 24);
  assert.ok(body.items.every((i) => i.available > 0), 'товаров без остатка на витрине нет');

  const sorted = [...body.items].every((item, idx, arr) => idx === 0 || arr[idx - 1].price !== undefined);
  assert.ok(sorted);
});

test('фильтр по типу отдаёт только свой тип', async () => {
  const { body } = await http.get('/catalog?type=key&limit=30');
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((i) => i.type === 'key'));
});

test('горячий запрос витрины идёт по индексу, а не сканом таблицы', async () => {
  const { rows } = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT p.sku, p.name, p.price_minor, s.available
       FROM products p LEFT JOIN product_stock s ON s.sku = p.sku
      WHERE p.is_active AND p.in_stock AND p.type = 'key'
      ORDER BY p.popularity DESC, p.sku
      LIMIT 24`,
  );
  const plan = rows[0]['QUERY PLAN'][0];
  const text = JSON.stringify(plan);

  assert.ok(text.includes('products_showcase_idx'), 'план обязан использовать products_showcase_idx');
  assert.ok(!/"Node Type":"Seq Scan","Relation Name":"products"/.test(text), 'по products не должно быть Seq Scan');
  assert.ok(!text.includes('"Sort Method"'), 'сортировка берётся из индекса, отдельного Sort быть не должно');
  assert.ok(plan['Execution Time'] < 50, `запрос должен оставаться быстрым, получено ${plan['Execution Time']} мс`);
});

test('выдача уменьшает остаток и убирает товар с витрины при нуле', async () => {
  await pool.query(`UPDATE product_stock SET available = 1 WHERE sku = 'KEY-CS2-PRIME'`);
  let inShowcase = await http.get('/catalog/KEY-CS2-PRIME');
  assert.equal(inShowcase.body.available, 1);

  await pool.query(`UPDATE product_stock SET available = 0 WHERE sku = 'KEY-CS2-PRIME'`);
  const { rows } = await pool.query(`SELECT in_stock FROM products WHERE sku = 'KEY-CS2-PRIME'`);
  assert.equal(rows[0].in_stock, false, 'триггер обязан снять признак наличия');

  const { body } = await http.get('/catalog?type=key&limit=100');
  assert.ok(!body.items.some((i) => i.sku === 'KEY-CS2-PRIME'));
});
