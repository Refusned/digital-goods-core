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
const dbUrl = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop';

// Скрипт создаёт заказы и расходует ключи поставщиков, поэтому на базе с ценными данными
// он работать не должен. Осознанный запуск разрешается флагом.
if (process.env.ALLOW_DESTRUCTIVE_RACE !== '1') {
  process.stderr.write(
    'npm run race меняет данные: создаёт заказы и расходует ключи поставщиков.\n' +
    'Запускайте его на демонстрационной базе и подтвердите намерение:\n' +
    '  ALLOW_DESTRUCTIVE_RACE=1 npm run race\n',
  );
  process.exit(2);
}

const db = new pg.Client({ connectionString: dbUrl });
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
  const responses = await Promise.all(payloads.map((p) => post('/webhook/payment', p)));
  const allAccepted = responses.every((r) => r.status === 200);
  const final = await waitFor(order.id, ['delivered']);
  const after = await db.query(`SELECT count(*)::int AS n FROM supplier_stub.issued`);
  const deliveries = await db.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  const applied = await db.query(`SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1 AND outcome = 'applied'`, [order.id]);

  const keysConsumed = after.rows[0].n - before.rows[0].n;
  check('50 параллельных вебхуков -> ровно одна выдача и ровно один ключ',
    allAccepted && deliveries.rows[0].n === 1 && final.status === 'delivered'
      && keysConsumed === 1 && applied.rows[0].n === 1,
    {
      order: order.id, status: final.status, all_http_200: allAccepted, deliveries: deliveries.rows[0].n,
      keys_consumed: keysConsumed, applied_events: applied.rows[0].n,
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
  const issued = await db.query('SELECT count(*)::int AS n FROM supplier_stub.issued WHERE order_id = $1', [order.id]);
  check('20 повторов одного event_id -> одно событие, одна выдача, один ключ',
    stored.rows[0].n === 1 && deliveries.rows[0].n === 1 && issued.rows[0].n === 1 && final.status === 'delivered',
    { order: order.id, stored_events: stored.rows[0].n, deliveries: deliveries.rows[0].n,
      supplier_issued: issued.rows[0].n, status: final.status });
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

// --- Сценарий 4: порядок доставки не влияет на итог ------------------------
{
  const outcomes = [];
  for (const mode of ['paid_first', 'failed_first']) {
    const orderId = `ord_ooo_${mode}_${Math.random().toString(36).slice(2, 6)}`;
    const { body: order } = await post('/orders', { sku: 'KEY-GTA5', order_id: orderId });
    const sameTime = new Date().toISOString();

    const paidEvt = {
      event_id: `ooo_paid_${orderId}`, order_id: orderId, status: 'paid',
      amount: order.amount, currency: 'RUB', created_at: sameTime,
    };
    const failedEvt = {
      event_id: `ooo_failed_${orderId}`, order_id: orderId, status: 'failed',
      amount: order.amount, currency: 'RUB', created_at: sameTime,
    };

    if (mode === 'paid_first') {
      await post('/webhook/payment', paidEvt);
      await post('/webhook/payment', failedEvt);
    } else {
      await post('/webhook/payment', failedEvt);
      await post('/webhook/payment', paidEvt);
    }

    // Проверяем именно судьбу ОПЛАТЫ: дошёл ли заказ до выдачи, зависит ещё и от наличия ключей.
    const final = await waitFor(orderId, ['delivered', 'out_of_stock', 'delivery_failed', 'payment_failed']);
    outcomes.push({ mode, status: final.status, paid: Boolean(final.paid_at) });
  }

  check('одинаковый набор событий даёт один итог при любом порядке доставки',
    outcomes.every((o) => o.paid && o.status !== 'payment_failed'), { outcomes });
}

// --- Сценарий 5: оплата без суммы или в чужой валюте не проходит ------------
{
  const { body: order } = await post('/orders', { sku: 'KEY-CS2-PRIME' });

  const noAmount = await post('/webhook/payment', {
    event_id: `bad_amt_${order.id}`, order_id: order.id, status: 'paid',
    currency: 'RUB', created_at: new Date().toISOString(),
  });
  const wrongCurrency = await post('/webhook/payment', {
    event_id: `bad_cur_${order.id}`, order_id: order.id, status: 'paid',
    amount: order.amount, currency: 'USD', created_at: new Date().toISOString(),
  });
  const { body: after } = await get(`/orders/${order.id}`);

  check('оплата без суммы отклоняется, оплата в чужой валюте не выдаёт товар',
    noAmount.status === 400 && wrongCurrency.body.outcome === 'currency_mismatch' && after.status === 'created',
    { no_amount_http: noAmount.status, wrong_currency: wrongCurrency.body.outcome, order_status: after.status });
}

// --- Итог -------------------------------------------------------------------
const rec = await get('/admin/reconciliation');
check('журнал денежных движений сходится', rec.body.ledger.balanced === true, rec.body.ledger);

await db.end();
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} проверок пройдено\n`);
process.exit(failed.length ? 1 : 0);
