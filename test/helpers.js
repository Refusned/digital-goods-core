import { createApp } from '../src/app.js';
import { createSupplierStub } from '../src/suppliers/stub.js';
import { createPaymentStub } from '../src/payments/stub.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { startWorker } from '../src/worker.js';

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const portOf = (server) => server.address().port;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Поднимает ядро и обе заглушки поставщиков на случайных портах.
 * Каждый тестовый файл работает со своей парой поставщиков, тесты не мешают друг другу.
 */
export async function startStack({ worker = false, workerIntervalMs = 150 } = {}) {
  const api = await listen(createApp());
  const stubA = await listen(createSupplierStub({ name: 'A' }));
  const stubB = await listen(createSupplierStub({ name: 'B' }));
  const payments = await listen(createPaymentStub());

  process.env.SUPPLIER_A_URL = `http://127.0.0.1:${portOf(stubA)}`;
  process.env.SUPPLIER_B_URL = `http://127.0.0.1:${portOf(stubB)}`;
  process.env.PAYMENT_STUB_URL = `http://127.0.0.1:${portOf(payments)}`;

  const base = `http://127.0.0.1:${portOf(api)}`;
  const supplierBase = { A: process.env.SUPPLIER_A_URL, B: process.env.SUPPLIER_B_URL };
  const stopWorker = worker ? startWorker({ intervalMs: workerIntervalMs }) : null;

  return {
    base,
    supplierBase,
    paymentBase: process.env.PAYMENT_STUB_URL,
    async stop() {
      if (stopWorker) await stopWorker();
      for (const s of [api, stubA, stubB, payments]) await new Promise((r) => s.close(r));
    },
  };
}

const SKUS = ['KEY-CS2-PRIME', 'KEY-GTA5', 'STEAM-TOPUP-500'];


/**
 * Очистка таблиц между сценариями.
 * Выдача запускается в фоне (её дёргает вебхук и не ждёт), поэтому к моменту очистки
 * фоновая транзакция может ещё держать строки. Это гонка теста, а не приложения:
 * ждём и повторяем, вместо того чтобы прятать её паузой наугад.
 */
async function truncateWithRetry(sql, attempts = 10) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(sql);
      return;
    } catch (err) {
      const busy = err.code === '40P01' || err.code === '55P03';   // deadlock, lock_not_available
      if (!busy || i === attempts) throw err;
      await sleep(120);
    }
  }
}

/** Полная очистка данных перед сценарием. Каталог и склады поставщиков засеваются заново. */
export async function resetData({ keysA = 5, keysB = 5 } = {}) {
  await truncateWithRetry(
    `TRUNCATE deliveries, supplier_requests, refunds, order_items, ledger_entries, payment_events,
              order_events, supplier_discrepancies, supplier_sync_state, supplier_rate_limits, orders CASCADE`);
  await truncateWithRetry('TRUNCATE supplier_stub.issued RESTART IDENTITY');
  await truncateWithRetry('TRUNCATE supplier_stub.keys RESTART IDENTITY');
  await truncateWithRetry('TRUNCATE payment_stub.refunds');
  // Журнал разрешений лимитера тоже относится к состоянию сценария: остатки от прошлого
  // теста съедали бы окно следующего.
  await truncateWithRetry('TRUNCATE supplier_rate_events');

  await pool.query(
    `INSERT INTO products (sku, name, type, price_minor, currency, popularity)
     VALUES ('KEY-CS2-PRIME', 'CS2 Prime Status ключ', 'key', 1290, 'RUB', 100),
            ('KEY-GTA5', 'GTA V ключ активации', 'key', 1990, 'RUB', 90),
            ('STEAM-TOPUP-500', 'Пополнение Steam 500 ₽', 'topup', 500, 'RUB', 80)
     ON CONFLICT (sku) DO UPDATE SET is_active = TRUE`,
  );

  // Ключи лежат на складах поставщиков и привязаны к товару: витрина потом строится по ним.
  const mk = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
  for (const sku of SKUS) {
    for (const code of mk(`AAAA-${sku}`, keysA)) {
      await pool.query('INSERT INTO supplier_stub.keys (supplier, sku, code) VALUES ($1, $2, $3)', ['A', sku, code]);
    }
    for (const code of mk(`BBBB-${sku}`, keysB)) {
      await pool.query('INSERT INTO supplier_stub.keys (supplier, sku, code) VALUES ($1, $2, $3)', ['B', sku, code]);
    }
  }

  await pool.query(
    `INSERT INTO product_stock (sku, available)
     SELECT p.sku, COALESCE(k.free, 0)
       FROM products p
       LEFT JOIN (SELECT sku, count(*) FILTER (WHERE taken_by IS NULL)::int AS free
                    FROM supplier_stub.keys GROUP BY sku) k ON k.sku = p.sku
     ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
  );
}

export const api = (base) => ({
  post: (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
  get: (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
});

/** Настроить поведение заглушки: доли сбоев либо детерминированный сценарий ответов. */
export const chaos = (supplierUrl, payload) =>
  fetch(`${supplierUrl}/_chaos`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }).then((r) => r.json());

export const supplierStats = (supplierUrl) => fetch(`${supplierUrl}/_stats`).then((r) => r.json());

export const restock = (supplierUrl, sku, codes) =>
  fetch(`${supplierUrl}/_restock`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku, codes }),
  }).then((r) => r.json());

export async function waitFor(fn, { timeoutMs = 8000, everyMs = 60 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

export const paidEvent = (orderId, amount, extra = {}) => ({
  event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  order_id: orderId,
  status: 'paid',
  amount,
  currency: 'RUB',
  created_at: new Date().toISOString(),
  ...extra,
});

export { pool, config };
