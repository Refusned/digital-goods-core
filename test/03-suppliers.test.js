import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, resetData, api, waitFor, paidEvent, chaos, supplierStats, pool } from './helpers.js';

let stack, http2post, http2get;

before(async () => {
  stack = await startStack();
  const client = api(stack.base);
  http2post = client.post;
  http2get = client.get;
});
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => {
  await resetData({ keysA: 5, keysB: 5 });
  await chaos(stack.supplierBase.A, { errorRate: 0, timeoutRate: 0, hangMs: 1200, script: [] });
  await chaos(stack.supplierBase.B, { errorRate: 0, timeoutRate: 0, hangMs: 1200, script: [] });
});

test('ловушка таймаута: поставщик выдал код, ответ не дошёл -> повтор НЕ создаёт вторую выдачу', async () => {
  // Первый вызов: заглушка резервирует код и зависает дольше клиентского таймаута.
  await chaos(stack.supplierBase.A, { script: ['timeout_issue'] });

  const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http2post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http2get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'после повтора заказ должен быть выдан');

  const statsA = await supplierStats(stack.supplierBase.A);
  assert.equal(statsA.issued, 1, 'поставщик выдал ровно один код, несмотря на таймаут и повтор');
  const freeForSku = await pool.query(
    `SELECT count(*)::int AS n FROM supplier_stub.keys
      WHERE supplier = 'A' AND sku = 'KEY-CS2-PRIME' AND taken_by IS NULL`);
  assert.equal(freeForSku.rows[0].n, 4, 'из пула товара ушёл ровно один ключ');

  const deliveries = await pool.query('SELECT count(*)::int AS n, min(code) AS code FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);
  assert.equal(deliveries.rows[0].code, delivered.delivery.code);

  const statsB = await supplierStats(stack.supplierBase.B);
  assert.equal(statsB.issued, 0, 'после таймаута уходить на резервного поставщика нельзя');

  const req = await pool.query(
    `SELECT supplier, state, attempts FROM supplier_requests WHERE order_id = $1 ORDER BY supplier`, [order.id]);
  assert.equal(req.rows.length, 1, 'обращались только к поставщику A');
  assert.equal(req.rows[0].state, 'ok');
  assert.ok(req.rows[0].attempts >= 2, 'был повтор с тем же request_id');
});

test('явный отказ поставщика A -> fallback на B, выдача ровно одна', async () => {
  await chaos(stack.supplierBase.A, { script: ['error', 'error', 'error'] });

  const { body: order } = await http2post('/orders', { sku: 'KEY-GTA5' });
  await http2post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http2get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered);
  assert.equal(delivered.delivery.supplier, 'B');
  assert.match(delivered.delivery.code, /^BBBB-/);

  assert.equal((await supplierStats(stack.supplierBase.A)).issued, 0);
  assert.equal((await supplierStats(stack.supplierBase.B)).issued, 1);

  const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
  assert.equal(deliveries.rows[0].n, 1);
});

test('поставщик A недоступен (соединение не устанавливается) -> fallback на B', async () => {
  // Берём реальный порт и сразу освобождаем: соединение к нему даёт честный ECONNREFUSED.
  const probe = http.createServer(() => {});
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const realA = process.env.SUPPLIER_A_URL;
  process.env.SUPPLIER_A_URL = `http://127.0.0.1:${deadPort}`;
  try {
    const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
    await http2post('/webhook/payment', paidEvent(order.id, order.amount));

    const delivered = await waitFor(async () => {
      const { body } = await http2get(`/orders/${order.id}`);
      return body.status === 'delivered' ? body : null;
    }, { timeoutMs: 10000 });

    assert.ok(delivered, 'резервный поставщик обязан закрыть заказ');
    assert.equal(delivered.delivery.supplier, 'B');
  } finally {
    process.env.SUPPLIER_A_URL = realA;
  }
});

test('поставщик молчит на всех попытках -> заказ остаётся восстановимым, резервный не трогается', async () => {
  await chaos(stack.supplierBase.A, { script: ['timeout_issue', 'timeout', 'timeout'], hangMs: 900 });

  const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http2post('/webhook/payment', paidEvent(order.id, order.amount));

  const stuck = await waitFor(async () => {
    const { rows } = await pool.query('SELECT status, next_attempt_at FROM orders WHERE id = $1', [order.id]);
    return rows[0].status === 'delivering' && rows[0].next_attempt_at ? rows[0] : null;
  }, { timeoutMs: 10000 });

  assert.ok(stuck, 'заказ должен ждать повтора, а не падать');
  assert.equal((await supplierStats(stack.supplierBase.B)).issued, 0, 'к резервному не пошли: судьба запроса неизвестна');

  // Сверка обязана показать такой заказ.
  const { body: report } = await http2get('/admin/reconciliation');
  assert.ok(report.paid_not_delivered.items.some((o) => o.id === order.id), 'заказ виден в "оплачен, но не выдан"');
  assert.ok(report.supplier_calls_unknown.items.some((r) => r.order_id === order.id), 'виден зависший вызов поставщика');

  // Поставщик ожил: ручная доводка идёт к НЕМУ ЖЕ и получает тот же код.
  await chaos(stack.supplierBase.A, { script: [] });
  const retry = await http2post(`/admin/orders/${order.id}/deliver`, {});
  assert.equal(retry.body.order.status, 'delivered');
  assert.equal((await supplierStats(stack.supplierBase.A)).issued, 1, 'код всё это время был один');
});

test('повторная ручная доводка выданного заказа ничего не меняет', async () => {
  const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http2post('/webhook/payment', paidEvent(order.id, order.amount));
  const delivered = await waitFor(async () => {
    const { body } = await http2get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  for (let i = 0; i < 5; i++) {
    const again = await http2post(`/admin/orders/${order.id}/deliver`, {});
    assert.equal(again.body.order.delivery.code, delivered.delivery.code);
  }
  const stats = await supplierStats(stack.supplierBase.A);
  assert.equal(stats.issued, 1);
});

test('параллельные повторы одного request_id: поставщик отдаёт один и тот же код', async () => {
  // Прямая проверка контракта заглушки: 50 одновременных повторов одного запроса
  // не должны зарезервировать 50 ключей.
  const requestId = `req_parallel_${Math.random().toString(36).slice(2, 8)}`;
  const before = await supplierStats(stack.supplierBase.A);

  const responses = await Promise.all(
    Array.from({ length: 50 }, () =>
      fetch(`${stack.supplierBase.A}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, sku: 'KEY-CS2-PRIME', order_id: 'ord_parallel' }),
      }).then((r) => r.json()).catch(() => ({ status: 'error' })),
    ),
  );

  const codes = new Set(responses.filter((r) => r.status === 'ok').map((r) => r.code));
  assert.equal(codes.size, 1, `поставщик обязан вернуть один код, вернул ${codes.size}`);

  const after = await supplierStats(stack.supplierBase.A);
  assert.equal(after.issued - before.issued, 1, 'зафиксирована ровно одна выдача');
  assert.equal(before.free - after.free, 1, 'из пула ушёл ровно один ключ');
});

test('обрыв соединения после выдачи трактуется как неизвестность, а не как отказ', async () => {
  // Поставщик принимает запрос, фиксирует код и рвёт сокет: ответ не доходит.
  // Ядро обязано повторить к нему же с тем же request_id, а не уйти на резервного.
  const issued = new Map();
  let calls = 0;

  const evil = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls += 1;
      const { request_id: requestId } = JSON.parse(body || '{}');
      if (issued.has(requestId)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', request_id: requestId, code: issued.get(requestId) }));
        return;
      }
      issued.set(requestId, 'EVIL-CODE-0001');   // код выдан
      req.socket.destroy();                       // а ответ не дойдёт
    });
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));

  const realA = process.env.SUPPLIER_A_URL;
  process.env.SUPPLIER_A_URL = `http://127.0.0.1:${evil.address().port}`;
  try {
    const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
    await http2post('/webhook/payment', paidEvent(order.id, order.amount));

    const delivered = await waitFor(async () => {
      const { body } = await http2get(`/orders/${order.id}`);
      return body.status === 'delivered' ? body : null;
    }, { timeoutMs: 10000 });

    assert.ok(delivered, 'заказ должен быть выдан после повтора к тому же поставщику');
    assert.equal(delivered.delivery.code, 'EVIL-CODE-0001', 'выдан код, который поставщик зафиксировал в первый раз');
    assert.ok(calls >= 2, 'к поставщику был повтор с тем же request_id');

    const statsB = await supplierStats(stack.supplierBase.B);
    assert.equal(statsB.issued, 0, 'резервный поставщик после неизвестного исхода не привлекается');

    const deliveries = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
    assert.equal(deliveries.rows[0].n, 1);
  } finally {
    process.env.SUPPLIER_A_URL = realA;
    await new Promise((r) => evil.close(r));
  }
});

test('временная ошибка 5xx повторяется к тому же поставщику, и только потом идёт резервный', async () => {
  await chaos(stack.supplierBase.A, { script: ['error', 'error', 'error'] });

  const { body: order } = await http2post('/orders', { sku: 'KEY-GTA5' });
  await http2post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http2get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered);
  assert.equal(delivered.delivery.supplier, 'B', 'после исчерпания повторов уходим на резервного');

  const chaosLeft = await fetch(`${stack.supplierBase.A}/_stats`).then((r) => r.json());
  assert.equal(chaosLeft.chaos.script.length, 0, 'все три ответа 503 были израсходованы, то есть повторы реально шли');

  const req = await pool.query(
    `SELECT supplier, state, attempts FROM supplier_requests WHERE order_id = $1 ORDER BY supplier`, [order.id]);
  const a = req.rows.find((r) => r.supplier === 'A');
  assert.equal(a.state, 'failed');
  assert.equal(a.attempts, 3, 'к поставщику A было три попытки с бэкоффом');
});

test('витринный остаток пересчитывается по складам поставщиков', async () => {
  const beforeStock = await pool.query(`SELECT available FROM product_stock WHERE sku = 'KEY-CS2-PRIME'`);
  const supplierFree = await pool.query(
    `SELECT count(*)::int AS n FROM supplier_stub.keys WHERE sku = 'KEY-CS2-PRIME' AND taken_by IS NULL`);
  assert.equal(beforeStock.rows[0].available, supplierFree.rows[0].n, 'витрина стартует с реального остатка');

  const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
  await http2post('/webhook/payment', paidEvent(order.id, order.amount));
  await waitFor(async () => {
    const { body } = await http2get(`/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  const afterStock = await pool.query(`SELECT available FROM product_stock WHERE sku = 'KEY-CS2-PRIME'`);
  const afterFree = await pool.query(
    `SELECT count(*)::int AS n FROM supplier_stub.keys WHERE sku = 'KEY-CS2-PRIME' AND taken_by IS NULL`);
  assert.equal(afterStock.rows[0].available, afterFree.rows[0].n, 'после выдачи витрина снова совпадает со складом');
  assert.equal(afterStock.rows[0].available, beforeStock.rows[0].available - 1);
});

test('завоз через админку кладёт ключи поставщику, а не рисует остаток на витрине', async () => {
  const before = await supplierStats(stack.supplierBase.A);
  const res = await http2post('/admin/stock/KEY-GTA5/restock', { codes: ['ADMIN-RESTOCK-1', 'ADMIN-RESTOCK-2'] });

  assert.equal(res.status, 200);
  assert.equal(res.body.added, 2);

  const after = await supplierStats(stack.supplierBase.A);
  assert.equal(after.free - before.free, 2, 'ключи реально появились на складе поставщика');

  const stock = await pool.query(`SELECT available FROM product_stock WHERE sku = 'KEY-GTA5'`);
  const free = await pool.query(
    `SELECT count(*)::int AS n FROM supplier_stub.keys WHERE sku = 'KEY-GTA5' AND taken_by IS NULL`);
  assert.equal(stock.rows[0].available, free.rows[0].n, 'витрина совпадает с фактическим остатком складов');
});

test('молчание поставщика не занижает витрину', async () => {
  const stockBefore = await pool.query(`SELECT available FROM product_stock WHERE sku = 'KEY-CS2-PRIME'`);

  const realB = process.env.SUPPLIER_B_URL;
  const probe = http.createServer(() => {});
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  process.env.SUPPLIER_B_URL = `http://127.0.0.1:${deadPort}`;

  try {
    const { body: order } = await http2post('/orders', { sku: 'KEY-CS2-PRIME' });
    await http2post('/webhook/payment', paidEvent(order.id, order.amount));
    await waitFor(async () => {
      const { body } = await http2get(`/orders/${order.id}`);
      return body.status === 'delivered' ? body : null;
    });

    const stockAfter = await pool.query(`SELECT available FROM product_stock WHERE sku = 'KEY-CS2-PRIME'`);
    assert.equal(stockAfter.rows[0].available, stockBefore.rows[0].available,
      'пока часть складов молчит, проекция остаётся прежней, а не падает до суммы ответивших');
  } finally {
    process.env.SUPPLIER_B_URL = realB;
  }
});
