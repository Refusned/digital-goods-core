/**
 * Второй этап, задача 1: заказ из нескольких товаров, где часть может не выдаться.
 *
 * Проверяется главное обещание такого заказа: что смогли выдать, остаётся у покупателя,
 * за что не смогли, деньги возвращаются, и по деньгам всё сходится при любом сбое и повторе.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, chaos, restock, pool, sleep } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 120 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 5, keysB: 5 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, hangMs: 800, script: [], rateLimitPerMin: 0 });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, hangMs: 800, script: [], rateLimitPerMin: 0 });
});

/** Время берём из базы: часы приложения и базы расходятся, а история живёт по часам базы. */
const nowInDb = async () => (await pool.query('SELECT now() AS t')).rows[0].t;

/** Деньги заказа обязаны сходиться в любой момент: оплачено = выдано + возвращено + ещё в работе. */
async function moneyOf(orderId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'pay:%'           AND direction = 'debit'), 0)  AS paid,
       COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'deliver:%'       AND direction = 'credit'), 0) AS delivered,
       COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'refund_accrue:%' AND direction = 'credit'), 0) AS refund_accrued,
       COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'refund_settle:%' AND direction = 'credit'), 0) AS refund_settled
     FROM ledger_entries WHERE order_id = $1`,
    [orderId],
  );
  const r = rows[0];
  return {
    paid: Number(r.paid),
    delivered: Number(r.delivered),
    refundAccrued: Number(r.refund_accrued),
    refundSettled: Number(r.refund_settled),
  };
}

test('заказ из нескольких товаров: каждая позиция получает свой код от своего поставщика', async () => {
  const { status, body: order } = await http.post('/orders', {
    items: [{ sku: 'KEY-CS2-PRIME', qty: 2 }, { sku: 'KEY-GTA5', qty: 1 }],
  });
  assert.equal(status, 201);
  assert.equal(order.items.length, 3, 'количество разворачивается в отдельные позиции');
  assert.equal(order.amount, 1290 * 2 + 1990, 'сумма заказа это сумма позиций');

  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 });

  assert.ok(delivered, 'заказ обязан дойти до конечного состояния');
  assert.equal(delivered.items.filter((i) => i.status === 'delivered').length, 3);

  const codes = new Set(delivered.items.map((i) => i.delivery.code));
  assert.equal(codes.size, 3, 'три позиции получили три РАЗНЫХ кода');

  const money = await moneyOf(order.id);
  assert.equal(money.paid, order.amount);
  assert.equal(money.delivered, order.amount, 'вся сумма признана выручкой: выдано всё');
  assert.equal(money.refundAccrued, 0);
});

test('часть позиций выдать нельзя: выданное остаётся, за остальное деньги возвращаются', async () => {
  // Ключей на второй товар нет ни у кого: одна позиция выдастся, вторая нет.
  await pool.query(`DELETE FROM supplier_stub.keys WHERE sku = 'KEY-GTA5'`);

  const { body: order } = await http.post('/orders', {
    items: [{ sku: 'KEY-CS2-PRIME' }, { sku: 'KEY-GTA5' }],
  });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  // Ждём выдачи первой позиции, затем закрываем срок ожидания второй.
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.items.some((i) => i.status === 'delivered') ? body : null;
  }, { timeoutMs: 15000 });

  await pool.query(
    `UPDATE order_items SET deadline_at = now() - interval '1 second'
      WHERE order_id = $1 AND sku = 'KEY-GTA5'`, [order.id]);

  const finished = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'partially_delivered' ? body : null;
  }, { timeoutMs: 15000 });

  assert.ok(finished, 'заказ обязан дойти до конечного состояния, а не висеть вечно');

  const cs2 = finished.items.find((i) => i.sku === 'KEY-CS2-PRIME');
  const gta = finished.items.find((i) => i.sku === 'KEY-GTA5');
  assert.equal(cs2.status, 'delivered', 'что выдали, то у покупателя и остаётся');
  assert.ok(cs2.delivery.code);
  assert.equal(gta.status, 'refunded', 'за невыданное вернули деньги');
  assert.equal(gta.refund.status, 'settled');
  assert.equal(gta.refund.amount, 1990);

  const money = await moneyOf(order.id);
  assert.equal(money.paid, 1290 + 1990);
  assert.equal(money.delivered, 1290);
  assert.equal(money.refundSettled, 1990);
  assert.equal(money.delivered + money.refundSettled, money.paid, 'оплачено = выдано + возвращено');

  assert.equal(finished.money.in_flight, 0, 'после закрытия заказа денег в подвешенном состоянии нет');

  const { body: report } = await http.get('/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
  assert.deepEqual(report.money_per_order_broken, [], 'по деньгам расхождений нет ни по одному заказу');
});

test('ни одна позиция не выдалась: заказ полностью возвращён, деньги сходятся', async () => {
  await pool.query('DELETE FROM supplier_stub.keys');

  const { body: order } = await http.post('/orders', { items: [{ sku: 'KEY-CS2-PRIME', qty: 2 }] });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 10000 });

  await pool.query(`UPDATE order_items SET deadline_at = now() - interval '1 second' WHERE order_id = $1`, [order.id]);

  const refunded = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'refunded' ? body : null;
  }, { timeoutMs: 15000 });

  assert.ok(refunded);
  assert.equal(refunded.items.every((i) => i.status === 'refunded'), true);
  const money = await moneyOf(order.id);
  assert.equal(money.refundSettled, order.amount);
  assert.equal(money.delivered, 0);
});

test('повтор любого шага не создаёт лишних выдач и лишних возвратов', async () => {
  await pool.query(`DELETE FROM supplier_stub.keys WHERE sku = 'KEY-GTA5'`);

  const { body: order } = await http.post('/orders', {
    items: [{ sku: 'KEY-CS2-PRIME' }, { sku: 'KEY-GTA5' }],
  });

  // Оплата приходит трижды: разными событиями и повтором одного и того же.
  const event = paidEvent(order.id, order.amount);
  await Promise.all([
    http.post('/webhook/payment', event),
    http.post('/webhook/payment', event),
    http.post('/webhook/payment', paidEvent(order.id, order.amount)),
  ]);

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.items.some((i) => i.status === 'delivered') ? body : null;
  }, { timeoutMs: 15000 });

  await pool.query(
    `UPDATE order_items SET deadline_at = now() - interval '1 second' WHERE order_id = $1 AND sku = 'KEY-GTA5'`,
    [order.id]);

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'partially_delivered' ? body : null;
  }, { timeoutMs: 15000 });

  // Повторяем всё, что можно повторить: выдачу, разбор возвратов, выплату.
  await http.post(`/admin/orders/${order.id}/deliver`, {});
  await http.post('/admin/refunds/run', {});
  await http.post('/admin/refunds/run', {});
  await http.post(`/admin/orders/${order.id}/deliver`, {});
  await sleep(400);

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1, 'выдача ровно одна');

  const refunds = await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = $1', [order.id]);
  assert.equal(refunds.rows[0].n, 1, 'возврат ровно один');

  const gatewayCalls = await pool.query('SELECT count(*)::int AS n FROM payment_stub.refunds WHERE order_id = $1', [order.id]);
  assert.equal(gatewayCalls.rows[0].n, 1, 'шлюз выплатил деньги ровно один раз');

  const money = await moneyOf(order.id);
  assert.equal(money.delivered + money.refundSettled, money.paid);
});

test('заказ доходит до конечного состояния после аварийной остановки посреди выдачи', async () => {
  // Поставщик A выдаёт код и не отвечает: ровно та ситуация, когда процесс мог умереть
  // между выдачей у поставщика и записью у нас.
  await chaos(stack.supplierBase.A, { script: ['timeout_issue', 'timeout_issue'], hangMs: 700 });
  await pool.query(`DELETE FROM supplier_stub.keys WHERE supplier = 'B'`);

  const { body: order } = await http.post('/orders', { items: [{ sku: 'KEY-CS2-PRIME', qty: 2 }] });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 20000 });

  assert.ok(delivered, 'фоновая доводка обязана закрыть заказ сама');
  const codes = delivered.items.map((i) => i.delivery.code);
  assert.equal(new Set(codes).size, 2, 'коды разные');

  const issuedByA = await pool.query(
    `SELECT count(*)::int AS n FROM supplier_stub.issued WHERE supplier = 'A' AND released_at IS NULL`);
  assert.equal(issuedByA.rows[0].n, 2, 'у поставщика израсходовано ровно два ключа, лишних выдач не было');

  const money = await moneyOf(order.id);
  assert.equal(money.delivered, order.amount);
});

test('заказ из нескольких товаров с частичной выдачей виден в сверке и в истории', async () => {
  await pool.query(`DELETE FROM supplier_stub.keys WHERE sku = 'KEY-GTA5'`);

  const { body: order } = await http.post('/orders', {
    items: [{ sku: 'KEY-CS2-PRIME' }, { sku: 'KEY-GTA5' }],
  });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.items.some((i) => i.status === 'delivered') ? body : null;
  }, { timeoutMs: 15000 });

  await pool.query(
    `UPDATE order_items SET deadline_at = now() - interval '1 second' WHERE order_id = $1 AND sku = 'KEY-GTA5'`,
    [order.id]);
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'partially_delivered' ? body : null;
  }, { timeoutMs: 15000 });

  // Восстановление картины на текущий момент из журнала событий.
  const { body: state } = await http.get(`/orders/${order.id}/at?ts=${(await nowInDb()).toISOString()}`);
  assert.equal(state.money.paid_minor, order.amount);
  assert.equal(state.money.delivered_minor + state.money.refund_settled_minor, order.amount,
    'история сходится с деньгами: выдано плюс возвращено равно оплаченному');

  const { body: report } = await http.get('/admin/reconciliation?overdue_seconds=0');
  assert.equal(report.paid_not_delivered.count, 0, 'позиция с возвратом больше не считается зависшей');
  assert.equal(report.healthy, true);
});

test('после завоза ожидающая позиция выдаётся, а не возвращается деньгами', async () => {
  await pool.query(`DELETE FROM supplier_stub.keys WHERE sku = 'KEY-GTA5'`);

  const { body: order } = await http.post('/orders', {
    items: [{ sku: 'KEY-CS2-PRIME' }, { sku: 'KEY-GTA5' }],
  });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 15000 });

  await restock(stack.supplierBase.A, 'KEY-GTA5', ['LATE-GTA5-0001']);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 });

  assert.ok(delivered, 'ожидание завоза не должно превращаться в возврат раньше срока');
  assert.equal(delivered.items.find((i) => i.sku === 'KEY-GTA5').delivery.code, 'LATE-GTA5-0001');

  const refunds = await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = $1', [order.id]);
  assert.equal(refunds.rows[0].n, 0, 'возврата не было');
});
