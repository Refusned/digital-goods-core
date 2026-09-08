/**
 * Сценарии приёмки ВТОРОГО этапа против ЖИВОГО сервера.
 *
 *   npm start                                  # в одном терминале
 *   ALLOW_DESTRUCTIVE_RACE=1 npm run stage2    # в другом
 *
 * Проверяет ровно то, что просит задание:
 *   1. заказ из нескольких товаров, часть которых не выдаётся: выданное остаётся, за остальное возврат;
 *   2. поставщик прислал дубль кода: второму покупателю уходит другой код;
 *   3. поставщик ответил ошибкой, хотя код выдал: второй выдачи не происходит;
 *   4. расхождения с поставщиком разбираются автоматически;
 *   5. всплеск заказов при лимите поставщика: ничего не теряется, лимит не превышен;
 *   6. деньги сходятся: оплачено = выдано + возвращено;
 *   7. состояние заказа и денег восстанавливается на прошлый момент.
 */
import pg from 'pg';

const base = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3010}`;
const supplierA = process.env.SUPPLIER_A_URL || `http://127.0.0.1:${process.env.SUPPLIER_A_PORT || 3121}`;
const supplierB = process.env.SUPPLIER_B_URL || `http://127.0.0.1:${process.env.SUPPLIER_B_PORT || 3122}`;
const dbUrl = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop';

if (process.env.ALLOW_DESTRUCTIVE_RACE !== '1') {
  process.stderr.write(
    'npm run stage2 меняет данные: создаёт заказы, расходует ключи поставщиков и делает возвраты.\n' +
    'Запускайте на демонстрационной базе и подтвердите намерение:\n' +
    '  ALLOW_DESTRUCTIVE_RACE=1 npm run stage2\n',
  );
  process.exit(2);
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const chaos = (supplier, payload) =>
  fetch(`${supplier}/_chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then((r) => r.json());
const stats = (supplier) => fetch(`${supplier}/_stats`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbNow = async () => (await db.query('SELECT now() AS t')).rows[0].t;

async function waitOrder(orderId, statuses, timeoutMs = 40000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { body } = await get(`/orders/${orderId}`);
    if (statuses.includes(body.status)) return body;
    await sleep(200);
  }
  return null;
}

let failed = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'}  ${name}\n`);
  if (!ok) {
    failed += 1;
    process.stdout.write(`      ${JSON.stringify(detail)}\n`);
  }
}

const catalog = await get('/catalog?limit=50');
const inStock = catalog.body.items.filter((i) => i.available > 0);
if (inStock.length < 2) {
  process.stderr.write('Нужны как минимум два товара в наличии. Запустите npm run seed.\n');
  process.exit(2);
}
const [goodSku, otherSku] = inStock.map((i) => i.sku);

// Под частичный сбой нужен товар, которого нет ни у одного поставщика.
// Если весь каталог в наличии, освобождаем один товар на складе заглушки: это стенд,
// и сценарий "часть заказа выдать нельзя" иначе не воспроизвести.
const missing = (await get('/catalog?limit=200')).body.items.find((i) => i.available === 0)?.sku ?? otherSku;
process.stdout.write(`      (товар для частичного сбоя: ${missing})\n`);

/**
 * Убедиться, что товара нет ни у одного поставщика.
 * Повтор нужен из-за фоновой сверки: она в этот момент может возвращать на склад
 * отбракованные ранее коды, и одиночная очистка окажется бесполезной.
 */
async function ensureEmptyStock(sku) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await db.query('DELETE FROM supplier_stub.keys WHERE sku = $1', [sku]);
    await post(`/admin/stock/${encodeURIComponent(sku)}/restock`, { codes: [] });   // пересчитать витрину
    let free = 0;
    for (const supplier of [supplierA, supplierB]) {
      const stock = await fetch(`${supplier}/stock?sku=${encodeURIComponent(sku)}`).then((r) => r.json());
      free += stock.items[0]?.available ?? 0;
    }
    if (free === 0) return true;
    await sleep(500);
  }
  return false;
}

if (!await ensureEmptyStock(missing)) {
  process.stderr.write(`У поставщика остались ключи ${missing}, сценарий частичного сбоя не воспроизвести.\n`);
  process.exit(2);
}

await chaos(supplierA, { errorRate: 0, timeoutRate: 0, script: [], rateLimitPerMin: 0 });
await chaos(supplierB, { errorRate: 0, timeoutRate: 0, script: [], rateLimitPerMin: 0 });

const startedAt = await dbNow();

// --- 1. Заказ из нескольких товаров, часть которых не выдаётся -----------------
{
  const items = missing
    ? [{ sku: goodSku }, { sku: missing }]
    : [{ sku: goodSku }, { sku: otherSku }];
  const { body: order } = await post('/orders', { items });

  await post('/webhook/payment', {
    event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    order_id: order.id, status: 'paid', amount: order.amount, currency: order.currency,
    created_at: new Date().toISOString(),
  });

  if (missing) {
    // Не ждём общий срок ожидания: закрываем его для заведомо невыдаваемой позиции.
    await waitOrder(order.id, ['delivering', 'out_of_stock', 'partially_delivered', 'delivered'], 20000);
    await db.query(
      `UPDATE order_items SET deadline_at = now() - interval '1 second' WHERE order_id = $1 AND sku = $2`,
      [order.id, missing],
    );
    const finished = await waitOrder(order.id, ['partially_delivered', 'refunded', 'delivered']);
    const delivered = finished?.items.filter((i) => i.status === 'delivered') ?? [];
    const refunded = finished?.items.filter((i) => i.status === 'refunded') ?? [];
    check('частичный сбой заказа: выданное осталось, за невыданное вернули деньги',
      finished?.status === 'partially_delivered' && delivered.length === 1 && refunded.length === 1,
      { order: order.id, status: finished?.status, items: finished?.items.map((i) => [i.sku, i.status]) });
    check('деньги по такому заказу сходятся: оплачено = выдано + возвращено',
      finished?.money.in_flight === 0 && finished.money.delivered + finished.money.refunded === finished.money.paid,
      finished?.money);
  } else {
    const finished = await waitOrder(order.id, ['delivered']);
    check('заказ из нескольких товаров выдан целиком', finished?.status === 'delivered',
      { order: order.id, status: finished?.status });
  }
}

// --- 2. Недобросовестный поставщик: дубль кода --------------------------------
{
  const { body: first } = await post('/orders', { sku: goodSku });
  await post('/webhook/payment', {
    event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    order_id: first.id, status: 'paid', amount: first.amount, currency: first.currency,
    created_at: new Date().toISOString(),
  });
  const firstDone = await waitOrder(first.id, ['delivered']);

  await chaos(supplierA, { script: ['duplicate_code'] });
  await chaos(supplierB, { script: ['duplicate_code'] });

  const { body: second } = await post('/orders', { sku: goodSku });
  await post('/webhook/payment', {
    event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    order_id: second.id, status: 'paid', amount: second.amount, currency: second.currency,
    created_at: new Date().toISOString(),
  });
  const secondDone = await waitOrder(second.id, ['delivered']);

  check('дубль кода от поставщика: второй покупатель получил другой код',
    Boolean(firstDone?.delivery && secondDone?.delivery) && firstDone.delivery.code !== secondDone.delivery.code,
    { first: firstDone?.delivery?.code, second: secondDone?.delivery?.code });

  const dup = await db.query(
    `SELECT count(*)::int AS n FROM deliveries WHERE code IN
       (SELECT code FROM deliveries GROUP BY code HAVING count(*) > 1)`);
  check('ни один код не ушёл двум покупателям', dup.rows[0].n === 0, dup.rows[0]);
}

// --- 3. Поставщик ответил ошибкой, хотя код выдал ------------------------------
{
  const before = await stats(supplierA);
  await chaos(supplierA, { script: ['error_after_issue'] });
  await chaos(supplierB, { script: ['error_after_issue'] });

  const { body: order } = await post('/orders', { sku: goodSku });
  await post('/webhook/payment', {
    event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    order_id: order.id, status: 'paid', amount: order.amount, currency: order.currency,
    created_at: new Date().toISOString(),
  });
  const done = await waitOrder(order.id, ['delivered']);
  const after = await stats(supplierA);

  check('поставщик соврал об ошибке: код забран, второй не запрошен',
    done?.status === 'delivered' && after.issued - before.issued <= 1,
    { order: order.id, status: done?.status, issued_delta: after.issued - before.issued });
}

// --- 4. Автоматический разбор расхождений --------------------------------------
{
  // Недоиспользованный сценарий предыдущей проверки не должен влиять на эту.
  await chaos(supplierA, { script: [] });
  await chaos(supplierB, { script: [] });

  // Берём поставщика и товар, которые реально есть на складе: иначе выдавать будет нечего.
  let target = null;
  let targetSku = null;
  for (const supplier of [supplierA, supplierB]) {
    const stock = await fetch(`${supplier}/stock`).then((r) => r.json());
    const available = stock.items.find((i) => i.available > 0);
    if (available) { target = supplier; targetSku = available.sku; break; }
  }
  if (!target) {
    process.stderr.write('Ни у одного поставщика не осталось свободных ключей, сценарий сверки пропущен.\n');
    process.exit(2);
  }

  const before = await stats(target);
  const orphan = `req_orphan_${Date.now()}`;
  const issued = await fetch(`${target}/issue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: orphan, sku: targetSku }),
  }).then((r) => r.json());

  const busy = await stats(target);
  const { body: audit } = await post('/admin/audit/run');
  const after = await stats(target);

  check('чужая выдача у поставщика найдена и возвращена на склад автоматически',
    issued.status === 'ok' && busy.free === before.free - 1 && after.free === before.free && audit.released >= 1,
    { issued: issued.status, before: before.free, busy: busy.free, after: after.free, audit });

  // Считаем только расхождения этого прогона: история прошлых запусков к сценарию не относится.
  const mine = await db.query(
    `SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
       FROM supplier_discrepancies WHERE detected_at >= $1 GROUP BY kind ORDER BY kind`,
    [startedAt],
  );
  check('расхождения зафиксированы и разобраны',
    mine.rows.length > 0 && mine.rows.every((r) => r.open === 0),
    mine.rows);
}

// --- 5. Всплеск заказов при лимите поставщика ----------------------------------
{
  // Всплеск проверяет очередь и лимит, а не остаток: склада должно хватать заведомо.
  const surgeSize = 40;
  await post(`/admin/stock/${encodeURIComponent(goodSku)}/restock`, {
    supplier: 'A',
    codes: Array.from({ length: surgeSize }, (_, i) => `SURGE-${Date.now()}-${i}`),
  });

  await chaos(supplierA, { script: [], rateLimitPerMin: 30, rateLimitWindowMs: 1000, resetStats: true });
  await chaos(supplierB, { script: [], rateLimitPerMin: 30, rateLimitWindowMs: 1000, resetStats: true });
  await post('/admin/suppliers/A/rate-limit', { capacity: 30, window_ms: 1000 });
  await post('/admin/suppliers/B/rate-limit', { capacity: 30, window_ms: 1000 });

  const orders = [];
  for (let i = 0; i < surgeSize; i++) {
    const { body } = await post('/orders', { sku: goodSku });
    orders.push(body);
  }
  await Promise.all(orders.map((o) => post('/webhook/payment', {
    event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    order_id: o.id, status: 'paid', amount: o.amount, currency: o.currency,
    created_at: new Date().toISOString(),
  })));

  const { body: queueMid } = await get('/admin/queue');
  const results = [];
  for (const order of orders) results.push(await waitOrder(order.id, ['delivered', 'partially_delivered', 'refunded']));

  const deliveredCount = results.filter((r) => r?.status === 'delivered').length;
  const statsA = await stats(supplierA);
  const statsB = await stats(supplierB);

  check('всплеск: ни один заказ не потерян', results.every(Boolean),
    { total: orders.length, resolved: results.filter(Boolean).length });
  check('лимит поставщика не превышен ни разу',
    statsA.calls.rate_limited === 0 && statsB.calls.rate_limited === 0,
    { A: statsA.calls, B: statsB.calls });
  check('прогресс очереди виден снаружи',
    typeof queueMid.queued === 'number' && Array.isArray(queueMid.rate_limits),
    queueMid);
  check('все заказы всплеска выданы', deliveredCount === orders.length,
    { delivered: deliveredCount, total: orders.length });

  await chaos(supplierA, { rateLimitPerMin: 0 });
  await chaos(supplierB, { rateLimitPerMin: 0 });
}

// --- 6. Деньги сходятся --------------------------------------------------------
{
  const { body: report } = await get('/admin/reconciliation');
  check('журнал денежных движений сходится', report.ledger.balanced === true, report.ledger);
  check('по каждому заказу оплачено = выдано + возвращено + в работе',
    Array.isArray(report.money_per_order_broken) && report.money_per_order_broken.length === 0,
    report.money_per_order_broken);
  check('нет невыплаченных возвратов с ошибкой', report.refunds_open.failed === 0, report.refunds_open);
  check('нет удержанных отбракованных кодов', report.supplier_codes_held.count === 0, report.supplier_codes_held);
}

// --- 7. Восстановление картины на прошлый момент -------------------------------
{
  const { body: early } = await get(`/admin/ledger/at?ts=${startedAt.toISOString()}`);
  const { body: now } = await get(`/admin/ledger/at?ts=${(await dbNow()).toISOString()}`);
  check('баланс на прошлый момент отличается от текущего и оба сходятся',
    early.balanced && now.balanced && now.total_debit_minor >= early.total_debit_minor,
    { early: early.total_debit_minor, now: now.total_debit_minor });

  const { body: period } = await get(
    `/admin/report?from=${startedAt.toISOString()}&to=${(await dbNow()).toISOString()}`);
  check('итоги за период сходятся с журналом денег', period.cross_check.matches === true, period.cross_check);
}

await db.end();
process.stdout.write(failed === 0 ? '\nвсе сценарии второго этапа пройдены\n' : `\nпровалено сценариев: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
