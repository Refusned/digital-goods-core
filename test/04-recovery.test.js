import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, chaos, restock, supplierStats, pool } from './helpers.js';

let stack, http;

// Здесь нужен живой фоновый воркер: проверяем именно автоматическое восстановление.
before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 150 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 0, keysB: 0, stock: 1 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, script: [] });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, script: [] });
});

test('пустой остаток: заказ оплачен, кода нет -> восстановимое состояние без падения', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  const hook = await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  assert.equal(hook.status, 200, 'вебхук принят, платёж не потерян');

  const stuck = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(stuck, 'заказ уходит в out_of_stock, а не в ошибку');
  assert.ok(stuck.paid_at, 'оплата зафиксирована');
  assert.equal(stuck.delivery, null);

  const { body: report } = await http.get('/admin/reconciliation');
  assert.ok(report.paid_not_delivered.items.some((o) => o.id === order.id), 'виден в "оплачен, но не выдан"');
  assert.equal(report.delivered_not_paid.count, 0);
  assert.equal(report.ledger.balanced, true);

  // Товар пропал с витрины: остаток обнулён.
  const { body: catalog } = await http.get('/catalog');
  assert.ok(!catalog.items.some((i) => i.sku === 'KEY-CS2-PRIME'), 'товар без остатка не показывается');
});

test('после пополнения пула фоновая задача сама доводит заказ, ровно один ключ', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 10000 });

  await restock(stack.supplierBase.A, 'KEY-CS2-PRIME', ['RESTOCK-0001', 'RESTOCK-0002']);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 });

  assert.ok(delivered, 'воркер обязан добить заказ без ручного вмешательства');
  assert.equal(delivered.delivery.code, 'RESTOCK-0001');

  const stats = await supplierStats(stack.supplierBase.A);
  assert.equal(stats.issued, 1, 'израсходован ровно один ключ');
  assert.equal(stats.free, 1, 'второй ключ остался в пуле');

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);

  const { body: report } = await http.get('/admin/reconciliation');
  assert.equal(report.healthy, true);
  assert.equal(report.paid_not_delivered.count, 0);
});

test('сверка честно признаёт систему нездоровой, пока оплаченный заказ не выдан', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  });

  // SLA задаём нулевым, чтобы не ждать: заказ уже просрочен по условиям проверки.
  const { body: report } = await http.get('/admin/reconciliation?overdue_seconds=0');
  assert.equal(report.paid_not_delivered.count, 1);
  assert.equal(report.ledger.balanced, true, 'бухгалтерия при этом сходится');
  assert.equal(report.healthy, false, 'но операционно система не здорова: деньги взяты, товар не отдан');
  assert.equal(report.health_details.paid_not_delivered_overdue, 1);
});

test('десять заказов на два ключа: выдано ровно два, остальные ждут пополнения', async () => {
  await restock(stack.supplierBase.A, 'KEY-GTA5', ['PAIR-0001', 'PAIR-0002']);

  const orders = await Promise.all(
    Array.from({ length: 10 }, () => http.post('/orders', { sku: 'KEY-GTA5' }).then((r) => r.body)),
  );
  await Promise.all(orders.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));

  await waitFor(async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries');
    return rows[0].n === 2 ? rows[0] : null;
  }, { timeoutMs: 15000 });

  await new Promise((r) => setTimeout(r, 800));   // даём воркеру шанс ошибиться

  const delivered = await pool.query('SELECT count(*)::int AS n FROM deliveries');
  assert.equal(delivered.rows[0].n, 2, 'ключей было два, выдач ровно две');

  const codes = await pool.query('SELECT count(DISTINCT code)::int AS n FROM deliveries');
  assert.equal(codes.rows[0].n, 2, 'коды не задвоились');

  const waiting = await pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE status IN ('out_of_stock', 'delivering', 'delivery_failed')`);
  assert.equal(waiting.rows[0].n, 8, 'остальные ждут в восстановимом состоянии');

  const { body: report } = await http.get('/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
  assert.equal(report.delivered_not_paid.count, 0);
});
