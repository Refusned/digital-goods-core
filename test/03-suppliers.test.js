import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, chaos, supplierStats, pool } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack(); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 5, keysB: 5 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, hangMs: 1200, script: [] });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, hangMs: 1200, script: [] });
});

test('ловушка таймаута: поставщик выдал код, ответ не дошёл -> повтор НЕ создаёт вторую выдачу', async () => {
  // Первый вызов: заглушка резервирует код и зависает дольше клиентского таймаута.
  await chaos(stack.supplierBase.A, { script: ['timeout_issue'] });

  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'после повтора заказ должен быть выдан');

  const statsA = await supplierStats(stack.supplierBase.A);
  assert.equal(statsA.issued, 1, 'поставщик выдал ровно один код, несмотря на таймаут и повтор');
  assert.equal(statsA.free, 4, 'из пула ушёл ровно один ключ');

  const deliveries = await pool.query('SELECT count(*)::int AS n, min(code) AS code FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);
  assert.equal(deliveries.rows[0].code, delivered.delivery.code);

  const statsB = await supplierStats(stack.supplierBase.B);
  assert.equal(statsB.issued, 0, 'после таймаута уходить на резервного поставщика нельзя');

  const req = await pool.query(
    `SELECT supplier, state, attempts FROM supplier_requests WHERE order_id = $1 ORDER BY supplier`, [order.id]);
  assert.equal(req.rows.length, 1, 'обращались только к поставщику A');
  assert.equal(req.rows[0].state, 'ok');
  assert.ok(req.rows[0].attempts >= 2, 'был повтор с тем же request_id');
});

test('явный отказ поставщика A -> fallback на B, выдача ровно одна', async () => {
  await chaos(stack.supplierBase.A, { script: ['error', 'error', 'error'] });

  const { body: order } = await http.post('/orders', { sku: 'KEY-GTA5' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered);
  assert.equal(delivered.delivery.supplier, 'B');
  assert.match(delivered.delivery.code, /^BBBB-/);

  assert.equal((await supplierStats(stack.supplierBase.A)).issued, 0);
  assert.equal((await supplierStats(stack.supplierBase.B)).issued, 1);

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);
});

test('поставщик A недоступен (соединение не устанавливается) -> fallback на B', async () => {
  const realA = process.env.SUPPLIER_A_URL;
  process.env.SUPPLIER_A_URL = 'http://127.0.0.1:1';  // порт, на котором никто не слушает
  try {
    const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
    await http.post('/webhook/payment', paidEvent(order.id, order.amount));

    const delivered = await waitFor(async () => {
      const { body } = await http.get(`/orders/${order.id}`);
      return body.status === 'delivered' ? body : null;
    }, { timeoutMs: 10000 });

    assert.ok(delivered, 'резервный поставщик обязан закрыть заказ');
    assert.equal(delivered.delivery.supplier, 'B');
  } finally {
    process.env.SUPPLIER_A_URL = realA;
  }
});

test('поставщик молчит на всех попытках -> заказ остаётся восстановимым, резервный не трогается', async () => {
  await chaos(stack.supplierBase.A, { script: ['timeout_issue', 'timeout', 'timeout'], hangMs: 900 });

  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const stuck = await waitFor(async () => {
    const { rows } = await pool.query('SELECT status, next_attempt_at FROM orders WHERE id = $1', [order.id]);
    return rows[0].status === 'delivering' && rows[0].next_attempt_at ? rows[0] : null;
  }, { timeoutMs: 10000 });

  assert.ok(stuck, 'заказ должен ждать повтора, а не падать');
  assert.equal((await supplierStats(stack.supplierBase.B)).issued, 0, 'к резервному не пошли: судьба запроса неизвестна');

  // Сверка обязана показать такой заказ.
  const { body: report } = await http.get('/admin/reconciliation');
  assert.ok(report.paid_not_delivered.items.some((o) => o.id === order.id), 'заказ виден в "оплачен, но не выдан"');
  assert.ok(report.supplier_calls_unknown.items.some((r) => r.order_id === order.id), 'виден зависший вызов поставщика');

  // Поставщик ожил: ручная доводка идёт к НЕМУ ЖЕ и получает тот же код.
  await chaos(stack.supplierBase.A, { script: [] });
  const retry = await http.post(`/admin/orders/${order.id}/deliver`, {});
  assert.equal(retry.body.order.status, 'delivered');
  assert.equal((await supplierStats(stack.supplierBase.A)).issued, 1, 'код всё это время был один');
});

test('повторная ручная доводка выданного заказа ничего не меняет', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  for (let i = 0; i < 5; i++) {
    const again = await http.post(`/admin/orders/${order.id}/deliver`, {});
    assert.equal(again.body.order.delivery.code, delivered.delivery.code);
  }
  const stats = await supplierStats(stack.supplierBase.A);
  assert.equal(stats.issued, 1);
});
