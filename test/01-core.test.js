import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack(); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData(); });

test('заказ создаётся по SKU и читается по id', async () => {
  const created = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'created');
  assert.equal(created.body.amount, 1290);
  assert.equal(created.body.delivery, null);

  const fetched = await http.get(`/orders/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.id, created.body.id);
});

test('несуществующий SKU -> 404, без заказа', async () => {
  const res = await http.post('/orders', { sku: 'NOPE' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'product_not_found');
});

test('оплата по вебхуку доводит заказ до выданного кода', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  const hook = await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  assert.equal(hook.status, 200);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  assert.ok(delivered, 'заказ должен дойти до delivered');
  assert.match(delivered.delivery.code, /^AAAA-KEY-CS2-PRIME-\d{4}$/);
  assert.equal(delivered.delivery.supplier, 'A');
  assert.ok(delivered.paid_at && delivered.delivered_at);
});

test('вебхук failed переводит заказ в payment_failed и выдачи не делает', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-GTA5' });
  await http.post('/webhook/payment', { ...paidEvent(order.id, order.amount), status: 'failed' });

  const { body } = await http.get(`/orders/${order.id}`);
  assert.equal(body.status, 'payment_failed');
  assert.equal(body.delivery, null);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(rows[0].n, 0);
});

test('Idempotency-Key закрывает двойной клик "Купить"', async () => {
  const key = `idem_${Math.random().toString(36).slice(2)}`;
  const [a, b] = await Promise.all([
    http.post('/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key }),
    http.post('/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key }),
  ]);
  const ids = new Set([a.body.id, b.body.id]);
  assert.equal(ids.size, 1, 'два клика должны дать один заказ');

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1', [key]);
  assert.equal(rows[0].n, 1);
});

test('вебхук с чужой суммой не оплачивает заказ', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  const res = await http.post('/webhook/payment', paidEvent(order.id, 1));
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'amount_mismatch');

  const { body } = await http.get(`/orders/${order.id}`);
  assert.equal(body.status, 'created');
});

test('вебхук в чужой валюте не оплачивает заказ', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  const res = await http.post('/webhook/payment', { ...paidEvent(order.id, order.amount), currency: 'USD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'currency_mismatch');

  const { body } = await http.get(`/orders/${order.id}`);
  assert.equal(body.status, 'created');
  assert.equal(body.delivery, null);
});

test('оплата без суммы или без валюты отклоняется с 400, товар не выдаётся', async () => {
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });

  const noAmount = await http.post('/webhook/payment', {
    event_id: `e_${Math.random().toString(36).slice(2)}`, order_id: order.id,
    status: 'paid', currency: 'RUB', created_at: new Date().toISOString(),
  });
  assert.equal(noAmount.status, 400);

  const noCurrency = await http.post('/webhook/payment', {
    event_id: `e_${Math.random().toString(36).slice(2)}`, order_id: order.id,
    status: 'paid', amount: order.amount, created_at: new Date().toISOString(),
  });
  assert.equal(noCurrency.status, 400);

  const badAmount = await http.post('/webhook/payment', {
    ...paidEvent(order.id, order.amount), amount: 'not-a-number',
  });
  assert.equal(badAmount.status, 400);

  const noDate = await http.post('/webhook/payment', {
    event_id: `e_${Math.random().toString(36).slice(2)}`, order_id: order.id,
    status: 'paid', amount: order.amount, currency: 'RUB',
  });
  assert.equal(noDate.status, 400);

  const { body } = await http.get(`/orders/${order.id}`);
  assert.equal(body.status, 'created');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1', [order.id]);
  assert.equal(rows[0].n, 0, 'битые события в журнал не попадают');
});

test('битый вебхук отклоняется с 400', async () => {
  const res = await http.post('/webhook/payment', { order_id: 'ord_x', status: 'paid' });
  assert.equal(res.status, 400);
});
