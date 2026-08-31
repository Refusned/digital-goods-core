/**
 * Проверка гонок из критериев приёмки, одним запуском против ЖИВОГО сервера.
 *
 *   npm start            # в одном терминале
 *   npm run race         # в другом
 *
 * Сценарии:
 *   1. 50 параллельных вебхуков "оплачено" по одному заказу -> ровно одна выдача;
 *   2. повторная доставка того же event_id -> ничего не меняется;
 *   3. вебхук раньше создания заказа -> заказ доедет до выданного.
 */
import pg from 'pg';

const base = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3010}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop' });
await db.connect();

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(orderId, statuses, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { body } = await get(`/orders/${orderId}`);
    if (statuses.includes(body.status)) return body;
    await sleep(120);
  }
  const { body } = await get(`/orders/${orderId}`);
  return body;
}

const results = [];
const check = (name, ok, details) => {
  results.push({ name, ok, details });
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(details)}\n`);
};

// --- Сценарий 1: 50 параллельных вебхуков по одному заказу -----------------
{
  const { body: order } = await post('/orders', { sku: 'KEY-CS2-PRIME' });
  const payloads = Array.from({ length: 50 }, (_, i) => ({
    event_id: `race_${order.id}_${i}`,
    order_id: order.id,
    status: 'paid',
    amount: order.amount,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  }));
  const before = await db.query(`SELECT count(*)::int AS n FROM supplier_stub.issued`);
  await Promise.all(payloads.map((p) => post('/webhook/payment', p)));
  const final = await waitFor(order.id, ['delivered']);
  const after = await db.query(`SELECT count(*)::int AS n FROM supplier_stub.issued`);
  const deliveries = await db.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  const applied = await db.query(`SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1 AND outcome = 'applied'`, [order.id]);

  check('50 параллельных вебхуков -> ровно одна выдача', deliveries.rows[0].n === 1 && final.status === 'delivered', {
    order: order.id, status: final.status, deliveries: deliveries.rows[0].n,
    keys_consumed: after.rows[0].n - before.rows[0].n, applied_events: applied.rows[0].n, code: final.delivery?.code,
  });
}

// --- Сценарий 2: повтор того же event_id ------------------------------------
{
  const { body: order } = await post('/orders', { sku: 'KEY-GTA5' });
  const event = {
    event_id: `dup_${order.id}`, order_id: order.id, status: 'paid',
    amount: order.amount, currency: 'RUB', created_at: new Date().toISOString(),
  };
  await Promise.all(Array.from({ length: 20 }, () => post('/webhook/payment', event)));
  const final = await waitFor(order.id, ['delivered']);
  const stored = await db.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [event.event_id]);
  const deliveries = await db.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  check('20 повторов одного event_id -> одно событие, одна выдача',
    stored.rows[0].n === 1 && deliveries.rows[0].n === 1 && final.status === 'delivered',
    { order: order.id, stored_events: stored.rows[0].n, deliveries: deliveries.rows[0].n, status: final.status });
}

// --- Сценарий 3: вебхук раньше заказа --------------------------------------
{
  const orderId = `ord_early_${Math.random().toString(36).slice(2, 8)}`;
  const early = await post('/webhook/payment', {
    event_id: `early_${orderId}`, order_id: orderId, status: 'paid',
    amount: 1290, currency: 'RUB', created_at: new Date().toISOString(),
  });

  const rec = await get('/admin/reconciliation');
  const orphanBefore = rec.body.payment_events_without_order.items.some((e) => e.order_id === orderId);

  // Заказ создаётся ПОСЛЕ платежа, с тем же id, как его знает платёжная система.
  const { body: order } = await post('/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });
  const final = await waitFor(order.id, ['delivered']);
  const deliveries = await db.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [orderId]);

  check('вебхук раньше заказа -> заказ доехал до выданного, ровно одна выдача',
    early.status === 200 && orphanBefore && final.status === 'delivered' && deliveries.rows[0].n === 1,
    { order: orderId, webhook_http: early.status, was_orphan: orphanBefore, final_status: final.status, deliveries: deliveries.rows[0].n });
}

// --- Сценарий 4: вебхуки не по порядку (failed после paid) ------------------
{
  const orderId = `ord_ooo_${Math.random().toString(36).slice(2, 8)}`;
  const { body: order } = await post('/orders', { sku: 'KEY-GTA5', order_id: orderId });
  const t0 = new Date();
  const older = new Date(t0.getTime() - 60_000).toISOString();

  await post('/webhook/payment', {
    event_id: `ooo_paid_${orderId}`, order_id: orderId, status: 'paid',
    amount: order.amount, currency: 'RUB', created_at: t0.toISOString(),
  });
  const stale = await post('/webhook/payment', {
    event_id: `ooo_failed_${orderId}`, order_id: orderId, status: 'failed',
    amount: order.amount, currency: 'RUB', created_at: older,
  });
  const final = await waitFor(orderId, ['delivered']);

  check('устаревший failed после paid не отменяет заказ',
    final.status === 'delivered' && stale.body.outcome === 'stale',
    { order: orderId, stale_outcome: stale.body.outcome, final_status: final.status });
}

// --- Итог -------------------------------------------------------------------
const rec = await get('/admin/reconciliation');
check('журнал денежных движений сходится', rec.body.ledger.balanced === true, rec.body.ledger);

await db.end();
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} проверок пройдено\n`);
process.exit(failed.length ? 1 : 0);
