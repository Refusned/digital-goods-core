/**
 * Второй этап, задача 3: всплеск заказов и лимит поставщика.
 *
 * Проверяется, что при потоке заказов сильно выше пропускной способности поставщика
 * не теряется ни один заказ, лимит поставщика ни разу не превышается,
 * оплаченные обслуживаются раньше неоплаченных, и прогресс очереди виден снаружи.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, chaos, pool } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 100 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 60, keysB: 60 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, script: [], rateLimitPerMin: 0, rateLimitWindowMs: 1000, resetStats: true });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, script: [], rateLimitPerMin: 0, rateLimitWindowMs: 1000, resetStats: true });
});

const supplierCalls = (base) => fetch(`${base}/_stats`).then((r) => r.json());

test('всплеск заказов: лимит поставщика не превышается и ни один заказ не теряется', async () => {
  // Поставщик принимает 10 выдач в секунду и жёстко отвечает 429 на одиннадцатую.
  await chaos(stack.supplierBase.A, { rateLimitPerMin: 10, rateLimitWindowMs: 1000 });
  await chaos(stack.supplierBase.B, { rateLimitPerMin: 10, rateLimitWindowMs: 1000 });
  await http.post('/admin/suppliers/A/rate-limit', { capacity: 10, window_ms: 1000 });
  await http.post('/admin/suppliers/B/rate-limit', { capacity: 10, window_ms: 1000 });

  // Заказов приходит втрое больше, чем поставщик способен обслужить за это время.
  const orders = await Promise.all(
    Array.from({ length: 30 }, () => http.post('/orders', { sku: 'KEY-CS2-PRIME' }).then((r) => r.body)),
  );
  await Promise.all(orders.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));

  // Очередь видна снаружи, пока разгребается.
  const { body: queue } = await http.get('/admin/queue');
  assert.ok(queue.queued + queue.in_flight + queue.delivered === 30, 'все позиции учтены в очереди');
  assert.ok(Array.isArray(queue.rate_limits) && queue.rate_limits.length === 2);

  const done = await waitFor(async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries');
    return rows[0].n === 30 ? rows[0] : null;
  }, { timeoutMs: 40000, everyMs: 200 });

  assert.ok(done, 'все 30 заказов обязаны быть выданы, ничего не теряется');

  const statsA = await supplierCalls(stack.supplierBase.A);
  const statsB = await supplierCalls(stack.supplierBase.B);
  assert.equal(statsA.calls.rate_limited, 0, 'лимит поставщика A ни разу не превышен');
  assert.equal(statsB.calls.rate_limited, 0, 'лимит поставщика B ни разу не превышен');

  const codes = await pool.query('SELECT count(DISTINCT code)::int AS n FROM deliveries');
  assert.equal(codes.rows[0].n, 30, 'все коды разные');

  const { body: report } = await http.get('/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
  assert.deepEqual(report.money_per_order_broken, []);
});

test('оплаченные заказы обслуживаются раньше неоплаченных', async () => {
  await chaos(stack.supplierBase.A, { rateLimitPerMin: 5, rateLimitWindowMs: 1000 });
  await chaos(stack.supplierBase.B, { rateLimitPerMin: 5, rateLimitWindowMs: 1000 });
  await http.post('/admin/suppliers/A/rate-limit', { capacity: 5, window_ms: 1000 });
  await http.post('/admin/suppliers/B/rate-limit', { capacity: 5, window_ms: 1000 });

  // Сначала в очередь встают неоплаченные заказы с предварительным резервом кода.
  const reserved = await Promise.all(
    Array.from({ length: 30 }, () =>
      http.post('/orders', { sku: 'KEY-CS2-PRIME', reserve: true }).then((r) => r.body)),
  );

  // Затем приходят оплаченные. Они встали в очередь позже, но обслуживаются раньше.
  const paid = await Promise.all(
    Array.from({ length: 5 }, () => http.post('/orders', { sku: 'KEY-CS2-PRIME' }).then((r) => r.body)),
  );
  await Promise.all(paid.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));

  // Проверка самого правила выбора, без зависимости от скорости: очередь, отсортированная
  // так же, как её читает диспетчер, начинается с оплаченных позиций.
  const queue = await pool.query(
    `SELECT i.id, i.priority, o.paid_at IS NOT NULL AS was_paid
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.status IN ('pending', 'delivering')
      ORDER BY i.priority, i.queued_at NULLS LAST, i.created_at
      LIMIT 10`,
  );
  const stillWaitingPaid = queue.rows.filter((r) => r.was_paid).length;
  if (stillWaitingPaid > 0) {
    const head = queue.rows.slice(0, stillWaitingPaid);
    assert.equal(head.every((r) => r.was_paid), true,
      'оплаченные позиции обязаны стоять в голове очереди, впереди резерва до оплаты');
  }

  const allPaidDelivered = await waitFor(async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM deliveries WHERE order_id = ANY($1)`, [paid.map((o) => o.id)]);
    return rows[0].n === 5 ? rows[0] : null;
  }, { timeoutMs: 30000, everyMs: 150 });
  assert.ok(allPaidDelivered, 'все оплаченные заказы обязаны быть выданы');

  // И по факту: пять оплаченных заказов закрылись раньше, чем разошлась очередь из тридцати резервов.
  const reservedDelivered = await pool.query(
    `SELECT count(*)::int AS n FROM deliveries WHERE order_id = ANY($1)`, [reserved.map((o) => o.id)]);
  assert.ok(reservedDelivered.rows[0].n < reserved.length,
    `резерв до оплаты не должен занимать лимит впереди денег (выдано резервов: ${reservedDelivered.rows[0].n} из ${reserved.length})`);
});

test('прогресс очереди виден: сколько ждёт, сколько выдано, сколько разрешений осталось', async () => {
  await chaos(stack.supplierBase.A, { rateLimitPerMin: 4, rateLimitWindowMs: 1000 });
  await chaos(stack.supplierBase.B, { rateLimitPerMin: 4, rateLimitWindowMs: 1000 });
  await http.post('/admin/suppliers/A/rate-limit', { capacity: 4, window_ms: 1000 });
  await http.post('/admin/suppliers/B/rate-limit', { capacity: 4, window_ms: 1000 });

  const orders = await Promise.all(
    Array.from({ length: 20 }, () => http.post('/orders', { sku: 'KEY-GTA5' }).then((r) => r.body)),
  );
  await Promise.all(orders.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));

  const mid = await waitFor(async () => {
    const { body } = await http.get('/admin/queue');
    return body.delivered > 0 && body.queued + body.in_flight > 0 ? body : null;
  }, { timeoutMs: 20000, everyMs: 100 });

  assert.ok(mid, 'в разгар всплеска очередь обязана показывать и выданное, и ожидающее');
  assert.ok(mid.oldest_wait_ms >= 0);
  assert.ok(mid.rate_limits.every((l) => l.available <= l.capacity));

  const done = await waitFor(async () => {
    const { body } = await http.get('/admin/queue');
    return body.queued === 0 && body.in_flight === 0 ? body : null;
  }, { timeoutMs: 40000, everyMs: 200 });

  assert.ok(done, 'очередь обязана разгрестись полностью');
  assert.equal(done.delivered, 20);

  // Обращения к поставщикам шли через лимитер, и лимит при этом не был превышен.
  const granted = done.rate_limits.reduce((sum, l) => sum + l.granted_total, 0);
  const statsA = await supplierCalls(stack.supplierBase.A);
  const statsB = await supplierCalls(stack.supplierBase.B);
  assert.ok(granted > 0, 'разрешения реально выдавались через лимитер');
  assert.equal(statsA.calls.rate_limited + statsB.calls.rate_limited, 0, 'ни одного отказа по лимиту');
});

test('лимитер не выдаёт больше разрешений, чем есть, даже при параллельном захвате', async () => {
  const { acquire, setLimit } = await import('../src/services/ratelimit.js');
  await setLimit('TEST-BUCKET', { capacity: 5, windowMs: 60_000 });

  // Двадцать параллельных попыток на лимит в пять запросов за окно.
  const granted = await Promise.all(Array.from({ length: 20 }, () => acquire('TEST-BUCKET', 1)));
  const total = granted.reduce((s, n) => s + n, 0);

  assert.equal(total, 5, 'выдано ровно столько разрешений, сколько помещается в окно');
});
