/**
 * Второй этап, задача 2: поставщик, которому нельзя доверять.
 *
 * Он может выдать один код дважды, прислать код от другого товара или ответить ошибкой,
 * хотя код на самом деле выдал. Проверяется, что покупатель всё равно получает ровно один
 * рабочий код, один код не уходит двум покупателям, а расхождения разбираются сами.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, chaos, supplierStats, pool, sleep, config } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 120 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 6, keysB: 6 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, hangMs: 700, script: [], rateLimitPerMin: 0 });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, hangMs: 700, script: [], rateLimitPerMin: 0 });
});

const deliveredOrder = (orderId, timeoutMs = 15000) => waitFor(async () => {
  const { body } = await http.get(`/orders/${orderId}`);
  return body.status === 'delivered' ? body : null;
}, { timeoutMs });

test('поставщик прислал ДУБЛЬ кода: второй покупатель получает другой код, дубль возвращён на склад', async () => {
  // Резервного поставщика убираем: важно, что ситуация разрешается у того же поставщика.
  await pool.query(`DELETE FROM supplier_stub.keys WHERE supplier = 'B'`);

  const { body: first } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(first.id, first.amount));
  const firstDone = await deliveredOrder(first.id);
  assert.ok(firstDone);

  // Следующая выдача вернёт код, который уже ушёл первому покупателю.
  await chaos(stack.supplierBase.A, { script: ['duplicate_code'] });

  const { body: second } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(second.id, second.amount));
  const secondDone = await deliveredOrder(second.id);

  assert.ok(secondDone, 'второй заказ обязан быть выдан, несмотря на недобросовестный ответ');
  assert.notEqual(secondDone.delivery.code, firstDone.delivery.code, 'один код не уходит двум покупателям');

  const codes = await pool.query('SELECT count(*)::int AS n, count(DISTINCT code)::int AS uniq FROM deliveries');
  assert.equal(codes.rows[0].n, codes.rows[0].uniq, 'все выданные коды различны');

  const { body: discrepancies } = await http.get('/admin/discrepancies');
  const dup = discrepancies.open.concat(discrepancies.recently_resolved).find((d) => d.kind === 'duplicate_code');
  assert.ok(dup, 'расхождение зафиксировано');
  assert.equal(dup.code, firstDone.delivery.code);
  assert.ok(dup.resolved_at, 'и разобрано автоматически');

  // Отбракованный код вернулся поставщику, а не исчез со склада.
  const rejected = await pool.query(
    `SELECT released_at FROM supplier_requests WHERE state = 'rejected' AND rejected_code = $1`,
    [firstDone.delivery.code]);
  assert.equal(rejected.rowCount, 1);
  assert.ok(rejected.rows[0].released_at, 'код возвращён поставщику');
});

test('поставщик прислал код ОТ ДРУГОГО товара: код отбракован, покупателю выдан правильный', async () => {
  await pool.query(`DELETE FROM supplier_stub.keys WHERE supplier = 'B'`);
  await chaos(stack.supplierBase.A, { script: ['foreign_code'] });

  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const done = await deliveredOrder(order.id);
  assert.ok(done, 'заказ обязан быть выдан правильным кодом');
  assert.match(done.delivery.code, /KEY-CS2-PRIME/, 'выдан код именно того товара, который купили');

  const { body: discrepancies } = await http.get('/admin/discrepancies');
  const foreign = discrepancies.open.concat(discrepancies.recently_resolved).find((d) => d.kind === 'foreign_code');
  assert.ok(foreign, 'чужой код зафиксирован как расхождение');
  assert.equal(foreign.detail.expected_sku, 'KEY-CS2-PRIME');
  assert.notEqual(foreign.detail.got_sku, 'KEY-CS2-PRIME');
});

test('поставщик ответил ошибкой, хотя код выдал: повтор не создаёт вторую выдачу', async () => {
  await pool.query(`DELETE FROM supplier_stub.keys WHERE supplier = 'B'`);
  await chaos(stack.supplierBase.A, { script: ['error_after_issue'] });

  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const done = await deliveredOrder(order.id);
  assert.ok(done, 'заказ обязан дойти до выданного кода');

  const stats = await supplierStats(stack.supplierBase.A);
  assert.equal(stats.issued, 1, 'у поставщика израсходован ровно один ключ, второй код не запрашивался');

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);

  const { body: discrepancies } = await http.get('/admin/discrepancies');
  const silent = discrepancies.open.concat(discrepancies.recently_resolved).find((d) => d.kind === 'silent_issue');
  assert.ok(silent, 'молчаливая выдача зафиксирована как расхождение');
  assert.equal(silent.code, done.delivery.code);
});

test('сверка сама находит код, который поставщик выдал, а мы не записали', async () => {
  // Моделируем аварию ровно в разрыве: поставщик выдал код по нашему запросу,
  // а процесс умер до записи выдачи. Наружу это выглядит как зависший оплаченный заказ.
  const { body: order } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
  const itemId = order.items[0].id;

  await pool.query(
    `UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [order.id]);
  // Диспетчер в этот сценарий не вмешивается: проверяем именно сверку, а не гонку с ней.
  await pool.query(
    `UPDATE order_items
        SET priority = 0, queued_at = now(), deadline_at = now() + interval '10 minutes',
            next_attempt_at = now() + interval '1 minute'
      WHERE id = $1`, [itemId]);

  const requestId = `req_${itemId}_A`;
  const issued = await fetch(`${stack.supplierBase.A}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, sku: 'KEY-CS2-PRIME', order_id: order.id }),
  }).then((r) => r.json());
  assert.equal(issued.status, 'ok');

  // Запрос у нас остался незавершённым: код есть у поставщика, у нас его нет.
  await pool.query(
    `INSERT INTO supplier_requests (request_id, order_id, order_item_id, supplier, epoch, state, attempts)
     VALUES ($1, $2, $3, 'A', 0, 'in_flight', 1)`,
    [requestId, order.id, itemId],
  );

  const { body: audit } = await http.post('/admin/audit/run', {});
  assert.ok(audit.attached >= 1, 'сверка обязана подобрать потерянный код');

  const fresh = await waitFor(async () => {
    const { body } = await http.get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });
  assert.ok(fresh, 'подобранный код обязан дойти до покупателя');
  assert.equal(fresh.delivery.code, issued.code, 'покупателю выдан именно тот код, который поставщик уже списал');

  const { body: discrepancies } = await http.get('/admin/discrepancies');
  const lost = discrepancies.recently_resolved.find((d) => d.kind === 'lost_code' && d.request_id === requestId);
  assert.ok(lost, 'расхождение зафиксировано и разобрано');
});

test('поставщик числит за нами код, которого мы не просили: он возвращается на склад сам', async () => {
  const before = await supplierStats(stack.supplierBase.A);

  const orphanRequest = 'req_someone_elses_request';
  const issued = await fetch(`${stack.supplierBase.A}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: orphanRequest, sku: 'KEY-CS2-PRIME' }),
  }).then((r) => r.json());
  assert.equal(issued.status, 'ok');

  const busy = await supplierStats(stack.supplierBase.A);
  assert.equal(busy.free, before.free - 1, 'ключ списан со склада');

  const { body: audit } = await http.post('/admin/audit/run', {});
  assert.ok(audit.released >= 1);

  const after = await supplierStats(stack.supplierBase.A);
  assert.equal(after.free, before.free, 'ключ вернулся на склад, товар не потерян');

  const { body: discrepancies } = await http.get('/admin/discrepancies');
  const orphan = discrepancies.recently_resolved.find((d) => d.kind === 'orphan_issue' && d.request_id === orphanRequest);
  assert.ok(orphan, 'расхождение зафиксировано и разобрано');
});

test('поток недобросовестных ответов: ни один код не уходит двум покупателям', async () => {
  await pool.query(`DELETE FROM supplier_stub.keys WHERE supplier = 'B'`);
  // Чередуем нормальные ответы с дублями, чужими кодами и молчаливой выдачей.
  await chaos(stack.supplierBase.A, {
    script: ['ok', 'duplicate_code', 'ok', 'foreign_code', 'error_after_issue', 'duplicate_code', 'ok', 'ok'],
    hangMs: 300,
  });

  const orders = [];
  for (let i = 0; i < 4; i++) {
    const { body } = await http.post('/orders', { sku: 'KEY-CS2-PRIME' });
    orders.push(body);
    await http.post('/webhook/payment', paidEvent(body.id, body.amount));
  }

  for (const order of orders) {
    const done = await deliveredOrder(order.id, 20000);
    assert.ok(done, `заказ ${order.id} обязан быть выдан`);
  }

  await sleep(300);

  const codes = await pool.query('SELECT count(*)::int AS n, count(DISTINCT code)::int AS uniq FROM deliveries');
  assert.equal(codes.rows[0].n, 4);
  assert.equal(codes.rows[0].uniq, 4, 'четыре покупателя получили четыре разных кода');

  const wrongSku = await pool.query(
    `SELECT count(*)::int AS n FROM deliveries d
      JOIN supplier_stub.keys k ON k.code = d.code
     WHERE k.sku IS DISTINCT FROM d.sku`);
  assert.equal(wrongSku.rows[0].n, 0, 'никому не достался код от чужого товара');

  const { body: report } = await http.get('/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
  assert.deepEqual(report.money_per_order_broken, []);
});

test('фоновая сверка разбирает расхождения сама, без ручного запуска', async () => {
  const wasEnabled = config.reconciler.enabled;
  const wasInterval = config.reconciler.intervalMs;
  config.reconciler.enabled = true;
  config.reconciler.intervalMs = 200;
  try {
    const before = await supplierStats(stack.supplierBase.A);

    // Поставщик списал ключ по запросу, которого мы не делали.
    const orphanRequest = `req_background_${Date.now()}`;
    await fetch(`${stack.supplierBase.A}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: orphanRequest, sku: 'KEY-CS2-PRIME' }),
    }).then((r) => r.json());

    const healed = await waitFor(async () => {
      const stats = await supplierStats(stack.supplierBase.A);
      return stats.free === before.free ? stats : null;
    }, { timeoutMs: 10000, everyMs: 150 });

    assert.ok(healed, 'фоновая сверка обязана вернуть чужой код на склад без участия человека');

    const { body: discrepancies } = await http.get('/admin/discrepancies');
    const found = discrepancies.recently_resolved.find((d) => d.request_id === orphanRequest);
    assert.ok(found, 'и зафиксировать расхождение');
  } finally {
    config.reconciler.enabled = wasEnabled;
    config.reconciler.intervalMs = wasInterval;
  }
});
