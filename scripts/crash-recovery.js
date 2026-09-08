/**
 * Аварийная остановка посреди выдачи: прямое доказательство пункта задания
 * «заказ доходит до конечного состояния даже после аварийной остановки и перезапуска».
 *
 *   ALLOW_DESTRUCTIVE_RACE=1 npm run crash
 *
 * Скрипт поднимает СВОЙ экземпляр сервиса на отдельных портах, ставит поставщика в режим
 * «код выдан, ответ не дойдёт», убивает процесс сигналом KILL ровно в момент выдачи
 * (никаких обработчиков завершения, никакого штатного закрытия соединений),
 * поднимает сервис заново и ждёт, чем всё закончится.
 *
 * Проверяется не только статус заказа: главное, чтобы после аварии не появилось лишних выдач
 * и лишних расходов ключей у поставщика.
 */
import { spawn } from 'node:child_process';
import pg from 'pg';

const dbUrl = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop';

if (process.env.ALLOW_DESTRUCTIVE_RACE !== '1') {
  process.stderr.write(
    'npm run crash поднимает свой сервис, создаёт заказы и убивает процесс сигналом KILL.\n' +
    'Запускайте на демонстрационной базе и подтвердите намерение:\n' +
    '  ALLOW_DESTRUCTIVE_RACE=1 npm run crash\n',
  );
  process.exit(2);
}

// Свои порты: скрипт не должен мешать серверу, который уже запущен для других проверок.
const PORT = Number(process.env.CRASH_PORT || 3210);
const SUPPLIER_A_PORT = Number(process.env.CRASH_SUPPLIER_A_PORT || 3211);
const SUPPLIER_B_PORT = Number(process.env.CRASH_SUPPLIER_B_PORT || 3212);
const PAYMENT_PORT = Number(process.env.CRASH_PAYMENT_PORT || 3213);

const base = `http://127.0.0.1:${PORT}`;
const supplierA = `http://127.0.0.1:${SUPPLIER_A_PORT}`;
const supplierB = `http://127.0.0.1:${SUPPLIER_B_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (url) => fetch(url).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();

let failed = 0;
const check = (name, ok, detail) => {
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'}  ${name}\n`);
  if (!ok) { failed += 1; process.stdout.write(`      ${JSON.stringify(detail)}\n`); }
};

function startService() {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPPLIER_A_PORT: String(SUPPLIER_A_PORT),
      SUPPLIER_B_PORT: String(SUPPLIER_B_PORT),
      PAYMENT_STUB_PORT: String(PAYMENT_PORT),
      SUPPLIER_A_URL: supplierA,
      SUPPLIER_B_URL: supplierB,
      WORKER_ENABLED: '1',
      WORKER_INTERVAL_MS: '500',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return child;
}

async function waitHealthy(timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch { /* сервис ещё поднимается */ }
    await sleep(200);
  }
  return false;
}

async function waitOrder(orderId, statuses, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const { body } = await get(`${base}/orders/${orderId}`);
      if (statuses.includes(body.status)) return body;
    } catch { /* сервис лежит, это ожидаемо */ }
    await sleep(300);
  }
  return null;
}

process.stdout.write('поднимаю свой экземпляр сервиса...\n');
let service = startService();
if (!await waitHealthy()) {
  process.stderr.write('сервис не поднялся, проверьте свободны ли порты 3210-3213\n');
  service.kill('SIGKILL');
  process.exit(2);
}

// Товар со своим складом: скрипт не должен зависеть от того, что осталось от других проверок.
const sku = 'KEY-CS2-PRIME';
await post(`${base}/admin/stock/${sku}/restock`, { supplier: 'A', count: 6 });

// Поставщик выдаёт код и не отвечает: заказ гарантированно окажется в середине выдачи.
await post(`${supplierA}/_chaos`, { script: ['timeout_issue', 'timeout_issue', 'timeout_issue', 'timeout_issue'], hangMs: 9000 });
await post(`${supplierB}/_chaos`, { script: [], errorRate: 0, timeoutRate: 0 });

const { body: order } = await post(`${base}/orders`, { items: [{ sku, qty: 2 }] });
await post(`${base}/webhook/payment`, {
  event_id: `crash_${order.id}`,
  order_id: order.id,
  status: 'paid',
  amount: order.amount,
  currency: order.currency,
  created_at: new Date().toISOString(),
});

const midFlight = await waitOrder(order.id, ['delivering', 'paid'], 10000);
const items = await db.query(
  `SELECT count(*) FILTER (WHERE status = 'delivering')::int AS delivering FROM order_items WHERE order_id = $1`,
  [order.id],
);
check('заказ действительно застигнут в середине выдачи',
  Boolean(midFlight) && items.rows[0].delivering > 0,
  { status: midFlight?.status, delivering: items.rows[0].delivering });

process.stdout.write(`убиваю процесс сигналом KILL (pid ${service.pid})...\n`);
service.kill('SIGKILL');
await sleep(1000);

const alive = await fetch(`${base}/health`).then(() => true).catch(() => false);
check('сервис лежит: обработчиков завершения не было', alive === false, { alive });

const afterCrash = await db.query(
  `SELECT status, count(*)::int AS n FROM order_items WHERE order_id = $1 GROUP BY status`, [order.id]);
const deliveriesAfterCrash = await db.query(
  'SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
process.stdout.write(`      состояние после аварии: ${JSON.stringify(afterCrash.rows)}, выдач: ${deliveriesAfterCrash.rows[0].n}\n`);

// Поставщик снова отвечает нормально: авария случилась, теперь система обязана добить заказ сама.
process.stdout.write('поднимаю сервис заново...\n');
service = startService();
if (!await waitHealthy()) {
  check('сервис поднялся после аварии', false, {});
  service.kill('SIGKILL');
  await db.end();
  process.exit(1);
}
await post(`${supplierA}/_chaos`, { script: [], errorRate: 0, timeoutRate: 0 });

const recovered = await waitOrder(order.id, ['delivered', 'partially_delivered', 'refunded'], 90000);
check('заказ дошёл до конечного состояния без вмешательства человека',
  recovered?.status === 'delivered',
  { status: recovered?.status, items: recovered?.items.map((i) => i.status) });

const deliveries = await db.query(
  'SELECT count(*)::int AS n, count(DISTINCT code)::int AS uniq FROM deliveries WHERE order_id = $1', [order.id]);
check('выдач ровно две, коды разные и не задвоились',
  deliveries.rows[0].n === 2 && deliveries.rows[0].uniq === 2, deliveries.rows[0]);

const issued = await db.query(
  `SELECT count(*)::int AS n FROM supplier_stub.issued i
     JOIN supplier_requests sr ON sr.request_id = i.request_id
    WHERE sr.order_id = $1 AND i.released_at IS NULL`, [order.id]);
check('у поставщика израсходовано ровно два ключа: авария не съела лишние',
  issued.rows[0].n === 2, issued.rows[0]);

const money = await db.query(
  `SELECT
     COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'pay:%'     AND direction = 'debit'), 0)  AS paid,
     COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'deliver:%' AND direction = 'credit'), 0) AS delivered
   FROM ledger_entries WHERE order_id = $1`, [order.id]);
check('деньги сходятся: оплачено равно выданному',
  Number(money.rows[0].paid) === Number(money.rows[0].delivered), money.rows[0]);

service.kill('SIGKILL');
await db.end();
process.stdout.write(failed === 0
  ? '\nсценарий аварийной остановки пройден\n'
  : `\nпровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
