import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, supplierStats, pool } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack(); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysA: 60, keysB: 60 }); });

test('50 параллельных вебхуков "оплачено" по одному заказу -> ровно одна выдача', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });

  const events = Array.from({ length: 50 }, () => paidEvent(order.id, order.amount));
  const responses = await Promise.all(events.map((e) => http.post('/webhook/payment', e)));
  assert.ok(responses.every((r) => r.status === 200), 'все вебхуки приняты');

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered, 'заказ обязан быть выдан (без потери)');

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1, 'выдача ровно одна');

  const stats = await supplierStats(stack.supplierBase.A);
  assert.equal(stats.issued, 1, 'у поставщика израсходован ровно один ключ');

  const applied = await pool.query(
    `SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1 AND outcome = 'applied'`, [order.id]);
  assert.equal(applied.rows[0].n, 1, 'деньги применены один раз');

  const money = await pool.query(
    `SELECT SUM(amount_minor) FILTER (WHERE direction='debit')::bigint AS d,
            SUM(amount_minor) FILTER (WHERE direction='credit')::bigint AS c
       FROM ledger_entries WHERE order_id = $1`, [order.id]);
  assert.equal(Number(money.rows[0].d), Number(money.rows[0].c), 'журнал сходится');
  assert.equal(Number(money.rows[0].d), order.amount * 2, 'ровно две проводки: оплата и выдача');
});

test('повторная доставка того же event_id ничего не меняет', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-GTA5' });
  const event = paidEvent(order.id, order.amount);

  const first = await http.post('/webhook/payment', event);
  assert.equal(first.body.outcome, 'applied');

  const repeats = await Promise.all(Array.from({ length: 20 }, () => http.post('/webhook/payment', event)));
  assert.ok(repeats.every((r) => r.status === 200 && r.body.outcome === 'duplicate'));

  await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  const stored = await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [event.event_id]);
  assert.equal(stored.rows[0].n, 1);
  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);
});

test('вебхук пришёл раньше заказа -> платёж не потерян, заказ доезжает до выданного', async () => {
  const orderId = `ord_pre_${Math.random().toString(36).slice(2, 8)}`;

  const early = await http.post('/webhook/payment', paidEvent(orderId, 1290));
  assert.equal(early.status, 200);
  assert.equal(early.body.outcome, 'pending_order');

  const pending = await pool.query(
    'SELECT processed_at, outcome FROM payment_events WHERE order_id = $1', [orderId]);
  assert.equal(pending.rows[0].processed_at, null);
  assert.equal(pending.rows[0].outcome, 'order_not_found');

  const created = await http.post('/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });
  assert.equal(created.status, 201);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${orderId}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered, 'заказ должен быть выдан сразу после создания');

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [orderId]);
  assert.equal(deliveries.rows[0].n, 1);
});

test('вебхуки не по порядку: устаревший failed не отменяет оплаченный заказ', async () => {
  const orderId = `ord_ord_${Math.random().toString(36).slice(2, 8)}`;
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });

  const now = new Date();
  await http.post('/webhook/payment', paidEvent(orderId, order.amount, { created_at: now.toISOString() }));

  const stale = await http.post('/webhook/payment', {
    ...paidEvent(orderId, order.amount, { created_at: new Date(now.getTime() - 60_000).toISOString() }),
    status: 'failed',
  });
  assert.equal(stale.body.outcome, 'stale');

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${orderId}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered);
});

test('параллельные вебхуки по РАЗНЫМ заказам не мешают друг другу', async () => {
  const orders = await Promise.all(
    Array.from({ length: 10 }, () => http.post('/orders', { sku: 'KEY-CS2-PRIME' }).then((r) => r.body)),
  );
  await Promise.all(orders.flatMap((o) => [
    http.post('/webhook/payment', paidEvent(o.id, o.amount)),
    http.post('/webhook/payment', paidEvent(o.id, o.amount)),
  ]));

  for (const o of orders) {
    const delivered = await waitFor(async () => {
      const { body } = await http.get(`/orders/${o.id}`);
      return body.status === 'delivered' ? body : null;
    });
    assert.ok(delivered, `заказ ${o.id} должен быть выдан`);
  }

  const codes = await pool.query('SELECT code, count(*)::int AS n FROM deliveries GROUP BY code HAVING count(*) > 1');
  assert.equal(codes.rowCount, 0, 'один код не может уйти в два заказа');

  const stats = await supplierStats(stack.supplierBase.A);
  assert.equal(stats.issued, 10, 'по одному ключу на заказ');
});
