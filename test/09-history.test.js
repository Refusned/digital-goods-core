/**
 * Второй этап, задача 4: восстановление картины на любой момент.
 *
 * Проверяется, что по истории операций можно поднять точное состояние заказа и денег
 * на прошлую дату, что историю нельзя переписать задним числом,
 * и что итоги за период, посчитанные из истории, сходятся с журналом денег.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, chaos, pool, sleep } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 120 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 5, keysB: 5 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, script: [], rateLimitPerMin: 0 });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, script: [], rateLimitPerMin: 0 });
});

const nowInDb = async () => (await pool.query('SELECT now() AS t')).rows[0].t;

test('состояние заказа восстанавливается на любой прошлый момент', async () => {
  const beforeAll = await nowInDb();

  const { body: order } = await http.post('/orders', { items: [{ sku: 'KEY-CS2-PRIME', qty: 2 }] });
  await sleep(60);
  const afterCreate = await nowInDb();

  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 });
  assert.ok(delivered);
  await sleep(60);
  const afterDeliver = await nowInDb();

  // До создания заказа истории нет, и ручка это честно говорит, а не выдумывает состояние.
  const early = await http.get(`/orders/${order.id}/at?ts=${beforeAll.toISOString()}`);
  assert.equal(early.status, 404);

  // Сразу после создания: заказ есть, деньги не пришли, кодов нет.
  const { body: created } = await http.get(`/orders/${order.id}/at?ts=${afterCreate.toISOString()}`);
  assert.equal(created.status, 'created');
  assert.equal(created.paid, false);
  assert.equal(created.money.paid_minor, 0);
  assert.equal(created.money.delivered_minor, 0);
  assert.equal(created.items.length, 2);
  assert.equal(created.items.every((i) => i.code === null), true, 'на тот момент кодов ещё не было');

  // После выдачи: деньги признаны выручкой, у каждой позиции свой код.
  const { body: done } = await http.get(`/orders/${order.id}/at?ts=${afterDeliver.toISOString()}`);
  assert.equal(done.paid, true);
  assert.equal(done.money.paid_minor, order.amount);
  assert.equal(done.money.delivered_minor, order.amount);
  assert.equal(done.items.filter((i) => i.status === 'delivered').length, 2);
  assert.equal(new Set(done.items.map((i) => i.code)).size, 2);

  // Восстановленная картина совпадает с фактическими кодами, а не пересказывает их приблизительно.
  const facts = await pool.query('SELECT code FROM deliveries WHERE order_id = $1 ORDER BY code', [order.id]);
  assert.deepEqual(done.items.map((i) => i.code).sort(), facts.rows.map((r) => r.code).sort());
});

test('баланс счетов восстанавливается на прошлый момент', async () => {
  const start = await nowInDb();

  const { body: first } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(first.id, first.amount));
  assert.ok(await waitFor(async () => {
    const { body } = await http.get(`/orders/${first.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 }), 'первый заказ обязан быть выдан');
  await sleep(60);
  const afterFirst = await nowInDb();

  const { body: second } = await http.post('/orders', { sku: 'KEY-GTA5' });
  await http.post('/webhook/payment', paidEvent(second.id, second.amount));
  assert.ok(await waitFor(async () => {
    const { body } = await http.get(`/orders/${second.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 }), 'второй заказ обязан быть выдан');

  const { body: early } = await http.get(`/admin/ledger/at?ts=${start.toISOString()}`);
  assert.equal(early.total_debit_minor, 0, 'на старте денег в системе не было');

  const { body: mid } = await http.get(`/admin/ledger/at?ts=${afterFirst.toISOString()}`);
  const cash = (report) => report.accounts.find((a) => a.account === 'cash')?.balance_minor ?? 0;
  assert.equal(cash(mid), first.amount, 'после первого заказа в кассе ровно его сумма');
  assert.equal(mid.balanced, true);

  const { body: now } = await http.get(`/admin/ledger/at?ts=${(await nowInDb()).toISOString()}`);
  assert.equal(cash(now), first.amount + second.amount);
  assert.equal(now.balanced, true);
});

test('история только дополняется: правка и удаление запрещены базой', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 });

  await assert.rejects(
    () => pool.query(`UPDATE order_events SET type = 'подделка' WHERE order_id = $1`, [order.id]),
    /append_only/,
    'переписать событие задним числом нельзя',
  );
  await assert.rejects(
    () => pool.query('DELETE FROM order_events WHERE order_id = $1', [order.id]),
    /append_only/,
    'удалить событие нельзя',
  );
  await assert.rejects(
    () => pool.query('UPDATE ledger_entries SET amount_minor = 1 WHERE order_id = $1', [order.id]),
    /append_only/,
    'переписать проводку нельзя',
  );
  await assert.rejects(
    () => pool.query('DELETE FROM ledger_entries WHERE order_id = $1', [order.id]),
    /append_only/,
    'удалить проводку нельзя',
  );

  // Запрет не мешает нормальной работе: заказ по-прежнему читается и остаётся выданным.
  const { body: fresh } = await http.get(`/orders/${order.id}`);
  assert.equal(fresh.status, 'delivered');
});

test('итоги за период считаются из истории и сходятся с журналом денег', async () => {
  const from = await nowInDb();

  // Один заказ выдаётся целиком, второй частично: будет и выручка, и возврат.
  const { body: full } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(full.id, full.amount));
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${full.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 15000 });

  await pool.query(`DELETE FROM supplier_stub.keys WHERE sku = 'KEY-GTA5'`);
  const { body: partial } = await http.post('/orders', {
    items: [{ sku: 'KEY-CS2-PRIME' }, { sku: 'KEY-GTA5' }],
  });
  await http.post('/webhook/payment', paidEvent(partial.id, partial.amount));
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${partial.id}`);
    return body.items.some((i) => i.status === 'delivered') ? body : null;
  }, { timeoutMs: 15000 });
  await pool.query(
    `UPDATE order_items SET deadline_at = now() - interval '1 second' WHERE order_id = $1 AND sku = 'KEY-GTA5'`,
    [partial.id]);
  await waitFor(async () => {
    const { body } = await http.get(`/orders/${partial.id}`);
    return body.status === 'partially_delivered' ? body : null;
  }, { timeoutMs: 15000 });

  const to = new Date(new Date(await nowInDb()).getTime() + 1000);
  const { body: report } = await http.get(`/admin/report?from=${from.toISOString()}&to=${to.toISOString()}`);

  assert.equal(report.orders_paid.count, 2);
  assert.equal(report.orders_paid.amount_minor, full.amount + partial.amount);
  assert.equal(report.items_delivered.count, 2, 'выдано две позиции: по одной из каждого заказа');
  assert.equal(report.refunds_settled.count, 1);
  assert.equal(report.refunds_settled.amount_minor, 1990);

  // Главная проверка: две независимые записи одного и того же факта сходятся.
  assert.equal(report.cross_check.matches, true, JSON.stringify(report.cross_check));
  assert.equal(report.cross_check.paid_diff_minor, 0);
  assert.equal(report.cross_check.delivered_diff_minor, 0);
  assert.equal(report.cross_check.refund_diff_minor, 0);

  // Деньги периода складываются: пришло = признано выручкой + возвращено.
  assert.equal(
    report.cross_check.cash_in_minor,
    report.cross_check.revenue_minor + report.cross_check.cash_out_minor,
  );
});
