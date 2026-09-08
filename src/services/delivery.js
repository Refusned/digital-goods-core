import { pool, withTx, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { supplierRequestId } from '../ids.js';
import { log } from '../logger.js';
import { issue, fetchStock, confirmIssued, verifyCode, releaseCode } from '../suppliers/client.js';
import { recordDelivery } from './ledger.js';
import { markItemRecoverable, refreshOrderStatus } from './orders.js';
import { EVENT, recordEvent } from './events.js';
import { recordDiscrepancy } from './supplier-audit.js';
import { acquire as acquireRateToken } from './ratelimit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suppliers = () => [config.suppliers.a, config.suppliers.b];

/**
 * Довести ОДНУ позицию заказа до выданного кода.
 *
 * Идемпотентна и безопасна к параллельному вызову: её одновременно дёргают обработчик вебхука,
 * диспетчер очереди и админка.
 *
 * Защита от двойной выдачи стоит на четырёх уровнях:
 *   1. сессионный advisory lock по позиции: параллельные попытки расходятся;
 *   2. детерминированный request_id внутри эпохи: повтор к поставщику возвращает ТОТ ЖЕ код;
 *   3. deliveries.order_item_id PRIMARY KEY: вторая выдача по позиции не вставится;
 *   4. deliveries.code UNIQUE: один код не уйдёт в два заказа, даже если поставщик прислал дубль.
 */
export async function deliverItem(itemId, { trigger = 'unknown' } = {}) {
  // Аренда позиции. Не держит соединение из пула, поэтому всплеск в сотни позиций
  // не выедает пул, и сама протухает, если процесс умер посреди выдачи.
  const lease = await pool.query(
    `UPDATE order_items
        SET locked_until = now() + ($2 || ' milliseconds')::interval
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())
     RETURNING id`,
    [itemId, String(leaseMs())],
  );
  if (lease.rowCount === 0) return { outcome: 'locked' };

  try {
    const { rows } = await pool.query(
      `SELECT i.*, o.paid_at, o.status AS order_status, d.code AS delivered_code
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
         LEFT JOIN deliveries d ON d.order_item_id = i.id
        WHERE i.id = $1`,
      [itemId],
    );
    if (rows.length === 0) return { outcome: 'item_not_found' };
    const item = rows[0];

    if (item.delivered_code) {
      // Выдача уже есть. Дотягиваем статус, если прошлый заход упал между INSERT и UPDATE.
      await pool.query(
        `UPDATE order_items SET status = 'delivered', next_attempt_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'delivered'`,
        [itemId],
      );
      await refreshOrderStatus(item.order_id);
      return { outcome: 'already_delivered', code: item.delivered_code };
    }

    if (!['pending', 'delivering'].includes(item.status)) {
      return { outcome: 'not_deliverable', status: item.status };
    }
    // Резерв до оплаты разрешён только явно (queued_at проставлен при создании заказа).
    if (!item.paid_at && !item.queued_at) {
      return { outcome: 'not_payable', status: item.order_status };
    }

    await pool.query(
      `UPDATE order_items SET status = 'delivering', updated_at = now() WHERE id = $1`,
      [itemId],
    );
    await recordEvent(null, { orderId: item.order_id, itemId, type: EVENT.itemDelivering, payload: { trigger, attempt: item.attempts + 1 } });

    // Отказ поставщика действует в пределах одной попытки: "нет остатка" и 5xx временны.
    // Записи ok, unknown и rejected не трогаем: они несут судьбу уже отправленных запросов.
    await pool.query(
      `UPDATE supplier_requests SET state = 'retryable', updated_at = now()
        WHERE order_item_id = $1 AND state = 'failed'`,
      [itemId],
    );

    const result = await acquireCode(item);

    // Попыткой считается только РЕАЛЬНОЕ обращение к поставщику. Ожидание в очереди
    // из-за лимита попыткой не является: иначе всплеск сам довёл бы заказы до возврата денег,
    // хотя выдать их никто даже не пробовал.
    if (result.calls > 0) {
      await pool.query('UPDATE order_items SET attempts = attempts + 1 WHERE id = $1', [itemId]);
    }

    if (result.outcome === 'ok') {
      const delivered = await finalizeDelivery(item, result);
      await syncStock(item.sku);
      return delivered;
    }

    if (result.outcome === 'rate_limited') {
      // Лимит поставщика исчерпан: позиция возвращается в очередь немедленно, ничего не теряется.
      //
      // Отсрочка здесь была бы ошибкой: позиция ни в чём не виновата, а любая задержка
      // отправила бы её в конец очереди и пустила бы вперёд менее приоритетные позиции,
      // которые задержки не получали. Холостых проходов это не создаёт: диспетчер вообще
      // не берёт работу, пока у поставщиков нет свободных разрешений.
      await markItemRecoverable(itemId, `rate_limited:${result.supplier}`, 0);
      await refreshOrderStatus(item.order_id);
      return { outcome: 'rate_limited' };
    }

    if (result.outcome === 'retry_later') {
      // Исход неизвестен: поставщик мог выдать код. Уходить на резервного нельзя, только повторять.
      await markItemRecoverable(itemId, `unknown:${result.supplier}`, backoffMs(item.attempts + 1));
      await refreshOrderStatus(item.order_id);
      return { outcome: 'retry_later' };
    }

    const outOfStock = result.reasons.some((r) => String(r.reason).includes('out_of_stock'));
    if (outOfStock) await syncStock(item.sku);

    await markItemRecoverable(
      itemId,
      result.reasons.map((r) => `${r.supplier}:${r.reason}`).join(', ') || 'delivery_failed',
      outOfStock ? config.worker.outOfStockRetryMs : backoffMs(item.attempts + 1),
    );
    await refreshOrderStatus(item.order_id);
    return { outcome: outOfStock ? 'out_of_stock' : 'delivery_failed', reasons: result.reasons };
  } finally {
    await pool.query('UPDATE order_items SET locked_until = NULL WHERE id = $1', [itemId]).catch(() => {});
  }
}

/**
 * Срок аренды: заведомо больше самого долгого честного пути выдачи
 * (несколько попыток к двум поставщикам с таймаутами и бэкоффом).
 */
const leaseMs = () =>
  config.supplierTimeoutMs * config.supplierMaxAttempts * 2 * (config.delivery.maxCodeRejections + 1) + 5000;

/**
 * Получить ГОДНЫЙ код у поставщиков.
 *
 * Отличие от первого этапа: ответу поставщика больше не верят на слово.
 *   - явный отказ проверяется вопросом "а что у тебя по этому запросу" (/issued):
 *     поставщик мог выдать код и всё равно ответить ошибкой;
 *   - полученный код проверяется на принадлежность товару (/verify): чужой код отбраковывается;
 *   - дубль ловит уникальный индекс по коду при записи выдачи.
 *
 * Отбракованный код возвращается поставщику, а замена просится НОВЫМ запросом следующей эпохи:
 * повторять тот же request_id бессмысленно, поставщик обязан вернуть по нему тот же негодный код.
 */
async function acquireCode(item) {
  const reasons = [];
  const counter = { calls: 0 };

  for (const supplier of suppliers()) {
    let epoch = await currentEpoch(item.id, supplier.name);
    let rejections = 0;

    while (rejections <= config.delivery.maxCodeRejections) {
      const requestId = supplierRequestId(item.id, supplier.name, epoch);
      const known = await pool.query(
        'SELECT state, code, reason FROM supplier_requests WHERE request_id = $1', [requestId]);
      const prev = known.rows[0];

      if (prev?.state === 'ok' && prev.code) {
        // Код уже получен и проверен на прошлом заходе: второй раз к поставщику не идём.
        return { outcome: 'ok', code: prev.code, supplier: supplier.name, requestId, calls: counter.calls };
      }
      if (prev?.state === 'failed') {
        reasons.push({ supplier: supplier.name, reason: prev.reason });
        break; // подтверждённый отказ, резервный поставщик разрешён
      }
      if (prev?.state === 'rejected') {
        // Эта эпоха уже закрыта негодным кодом, просим замену следующей.
        epoch += 1;
        rejections += 1;
        continue;
      }

      const attempt = await callSupplier(item, supplier, requestId, epoch, counter);

      if (attempt.outcome === 'rate_limited') {
        return { outcome: 'rate_limited', supplier: supplier.name, retryAfterMs: attempt.retryAfterMs, reasons, calls: counter.calls };
      }
      if (attempt.outcome === 'unknown') {
        return { outcome: 'retry_later', supplier: supplier.name, reasons, calls: counter.calls };
      }
      if (attempt.outcome === 'failed') {
        reasons.push({ supplier: supplier.name, reason: attempt.reason });
        break;
      }

      // Код на руках. Прежде чем закрепить его за позицией, проверяем, что он от нужного товара.
      const check = await verifyCode(supplier, attempt.code);
      if (check === null) {
        // Проверка временно недоступна. Признать код годным нельзя: fail closed, повторим позже.
        // Код закреплён за request_id, повтор вернёт его же, ничего не потеряется.
        await upsertSupplierRequest(requestId, item, supplier.name, 'unknown', { epoch, reason: 'verify_unavailable', code: attempt.code });
        return { outcome: 'retry_later', supplier: supplier.name, reasons, calls: counter.calls };
      }
      if (check.status === 'known' && check.sku && check.sku !== item.sku) {
        await rejectCode(item, supplier, requestId, epoch, attempt.code, 'foreign_code', {
          expected_sku: item.sku, got_sku: check.sku,
        });
        epoch += 1;
        rejections += 1;
        continue;
      }

      await upsertSupplierRequest(requestId, item, supplier.name, 'ok', { epoch, code: attempt.code });
      return { outcome: 'ok', code: attempt.code, supplier: supplier.name, requestId, epoch, calls: counter.calls };
    }

    if (rejections > config.delivery.maxCodeRejections) {
      reasons.push({ supplier: supplier.name, reason: 'too_many_bad_codes' });
    }
  }

  return { outcome: 'failed', reasons, calls: counter.calls };
}

/**
 * Один заход к поставщику: лимит, вызов, повторы на неопределённости
 * и проверка "а не выдал ли он всё-таки код" при явном отказе.
 */
async function callSupplier(item, supplier, requestId, epoch, counter) {
  let last = null;

  for (let attempt = 1; attempt <= config.supplierMaxAttempts; attempt++) {
    // Лимит поставщика соблюдается ДО отправки: узнавать о нём из 429 поздно.
    const granted = await acquireRateToken(supplier.name, 1);
    if (granted < 1) {
      log.debug('supplier.rate_budget_empty', { supplier: supplier.name, request_id: requestId });
      return { outcome: 'rate_limited', retryAfterMs: 500 };
    }

    await upsertSupplierRequest(requestId, item, supplier.name, 'in_flight', { epoch, attempts: attempt });
    counter.calls += 1;
    last = await issue(supplier, { requestId, sku: item.sku, orderId: item.order_id }, {});

    if (last.outcome === 'ok') return { outcome: 'ok', code: last.code };

    if (last.outcome === 'failed') {
      if (last.rateLimited) {
        // Наш счётчик разошёлся с счётчиком поставщика: это ошибка на нашей стороне, но
        // терять заказ из-за неё нельзя. Ждём и возвращаем позицию в очередь.
        await upsertSupplierRequest(requestId, item, supplier.name, 'retryable', { epoch, reason: 'rate_limited', attempts: attempt });
        return { outcome: 'rate_limited', retryAfterMs: last.retryAfterMs || 1000 };
      }

      // Соединения не было: байты не ушли, код выдан быть не мог. Переспрашивать некого,
      // и это единственный случай, когда отказ доказан без обращения к журналу поставщика.
      if (last.proven) {
        await upsertSupplierRequest(requestId, item, supplier.name, 'failed', { epoch, reason: last.reason, attempts: attempt });
        return { outcome: 'failed', reason: last.reason };
      }

      // Явному отказу не верим: поставщик мог выдать код и ответить ошибкой.
      const confirmed = await confirmIssued(supplier, requestId);
      if (confirmed?.issued) {
        await recordDiscrepancy({
          supplier: supplier.name, kind: 'silent_issue', requestId, itemId: item.id, code: confirmed.code,
          detail: { http_reason: last.reason },
          resolution: 'код забран по журналу поставщика, вторая выдача не запрашивалась',
        });
        log.warn('supplier.silent_issue', { supplier: supplier.name, request_id: requestId, reason: last.reason });
        return { outcome: 'ok', code: confirmed.code };
      }
      if (confirmed === null) {
        // Спросить не удалось: считать это отказом нельзя.
        await upsertSupplierRequest(requestId, item, supplier.name, 'unknown', { epoch, reason: `unconfirmed:${last.reason}`, attempts: attempt });
        return { outcome: 'unknown', reason: last.reason };
      }

      // Поставщик подтвердил, что кода нет. Временную беду повторяем к нему же.
      if (last.retryable && attempt < config.supplierMaxAttempts) {
        await upsertSupplierRequest(requestId, item, supplier.name, 'retryable', { epoch, reason: last.reason, attempts: attempt });
        await sleep(config.supplierBackoffBaseMs * 2 ** (attempt - 1));
        continue;
      }
      await upsertSupplierRequest(requestId, item, supplier.name, 'failed', { epoch, reason: last.reason, attempts: attempt });
      return { outcome: 'failed', reason: last.reason };
    }

    // unknown: повторяем с ТЕМ ЖЕ request_id, поставщик обязан вернуть тот же код.
    await upsertSupplierRequest(requestId, item, supplier.name, 'unknown', { epoch, reason: last.reason, attempts: attempt });
    if (attempt < config.supplierMaxAttempts) await sleep(config.supplierBackoffBaseMs * 2 ** (attempt - 1));
  }

  return { outcome: 'unknown', reason: last?.reason || 'unknown' };
}

/**
 * Отбраковка негодного кода: фиксируем инцидент, возвращаем код поставщику
 * и закрываем эпоху, чтобы замена пришла другим запросом.
 */
async function rejectCode(item, supplier, requestId, epoch, code, kind, detail) {
  await upsertSupplierRequest(requestId, item, supplier.name, 'rejected', { epoch, reason: kind, rejectedCode: code });
  await recordDiscrepancy({
    supplier: supplier.name, kind, requestId, itemId: item.id, code, detail,
    resolution: 'код отбракован и возвращён поставщику, запрошена замена',
  });
  await recordEvent(null, {
    orderId: item.order_id, itemId: item.id, type: EVENT.supplierRejectedCode,
    payload: { supplier: supplier.name, kind, request_id: requestId, ...detail },
  });

  const released = await releaseCode(supplier, requestId);
  if (released) {
    await pool.query('UPDATE supplier_requests SET released_at = now(), updated_at = now() WHERE request_id = $1', [requestId]);
  }
  log.warn('supplier.code_rejected', { supplier: supplier.name, request_id: requestId, kind, released: Boolean(released) });
}

async function currentEpoch(itemId, supplier) {
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(epoch), 0) AS epoch FROM supplier_requests WHERE order_item_id = $1 AND supplier = $2',
    [itemId, supplier],
  );
  return Number(rows[0].epoch);
}

async function upsertSupplierRequest(requestId, item, supplier, state, { code = null, reason = null, attempts = 0, epoch = null, rejectedCode = null } = {}) {
  await pool.query(
    `INSERT INTO supplier_requests (request_id, order_id, order_item_id, supplier, epoch, state, code, reason, attempts, rejected_code)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6, $7, $8, $9, $10)
     ON CONFLICT (request_id) DO UPDATE
        SET state = EXCLUDED.state,
            code = COALESCE(EXCLUDED.code, supplier_requests.code),
            reason = EXCLUDED.reason,
            rejected_code = COALESCE(EXCLUDED.rejected_code, supplier_requests.rejected_code),
            attempts = GREATEST(supplier_requests.attempts, EXCLUDED.attempts),
            updated_at = now()`,
    [requestId, item.order_id, item.id, supplier, epoch, state, code, reason, attempts, rejectedCode],
  );
}

/** Запись факта выдачи, статуса позиции, проводки и события одной транзакцией. */
async function finalizeDelivery(item, { code, supplier, requestId, epoch = 0 }) {
  try {
    return await withTx(async (client) => {
      await client.query('SELECT id FROM order_items WHERE id = $1 FOR UPDATE', [item.id]);

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO deliveries (order_item_id, order_id, sku, code, supplier, request_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (order_item_id) DO NOTHING
           RETURNING order_item_id`,
          [item.id, item.order_id, item.sku, code, supplier, requestId],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Код уже принадлежит другой выдаче: поставщик прислал дубль.
          // Уникальный индекс по коду это последний рубеж, за которым один код ушёл бы двум покупателям.
          throw Object.assign(new Error('duplicate_code'), { duplicate_code: true });
        }
        throw err;
      }

      if (inserted.rowCount === 0) {
        const existing = await client.query('SELECT code FROM deliveries WHERE order_item_id = $1', [item.id]);
        return { outcome: 'already_delivered', code: existing.rows[0]?.code };
      }

      await client.query(
        `UPDATE order_items SET status = 'delivered', last_error = NULL, next_attempt_at = NULL, updated_at = now()
          WHERE id = $1`,
        [item.id],
      );
      await recordDelivery(client, item.order_id, item.id, Number(item.amount_minor));
      await recordEvent(client, {
        orderId: item.order_id, itemId: item.id, type: EVENT.itemDelivered,
        amountMinor: Number(item.amount_minor),
        payload: { code, supplier, sku: item.sku, request_id: requestId },
      });
      await refreshOrderStatus(item.order_id, client);

      log.info('delivery.done', {
        order_id: item.order_id, item_id: item.id, sku: item.sku, supplier,
        request_id: requestId, code: maskCode(code),
      });
      return { outcome: 'delivered', code, supplier };
    });
  } catch (err) {
    if (!err.duplicate_code) throw err;

    // Дубль кода. Отбраковываем, возвращаем поставщику и просим замену следующей эпохой.
    const supplierCfg = suppliers().find((s) => s.name === supplier);
    const owner = await pool.query('SELECT order_item_id, order_id FROM deliveries WHERE code = $1', [code]);
    await rejectCode(item, supplierCfg, requestId, epoch, code, 'duplicate_code', {
      already_delivered_to_item: owner.rows[0]?.order_item_id ?? null,
      already_delivered_to_order: owner.rows[0]?.order_id ?? null,
    });
    await markItemRecoverable(item.id, 'duplicate_code', config.supplierBackoffBaseMs);
    return { outcome: 'duplicate_code', code_owner: owner.rows[0]?.order_id ?? null };
  }
}

/**
 * Совместимость с первым этапом и админкой: довести ВЕСЬ заказ.
 * Позиции обрабатываются последовательно, чтобы не устроить всплеск к поставщику
 * из одного заказа; для массовой выдачи есть диспетчер очереди.
 */
export async function deliverOrder(orderId, { trigger = 'unknown' } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM order_items
      WHERE order_id = $1 AND status IN ('pending', 'delivering')
      ORDER BY position`,
    [orderId],
  );
  if (rows.length === 0) {
    await refreshOrderStatus(orderId);
    const current = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (current.rowCount === 0) return { outcome: 'order_not_found' };
    const delivered = await pool.query(
      `SELECT count(*)::int AS n, min(code) AS code FROM deliveries WHERE order_id = $1`, [orderId]);
    return delivered.rows[0].n > 0
      ? { outcome: 'already_delivered', code: delivered.rows[0].code }
      : { outcome: 'not_deliverable', status: current.rows[0].status };
  }

  const results = [];
  for (const row of rows) results.push(await deliverItem(row.id, { trigger }));
  await refreshOrderStatus(orderId);

  // Итог заказа: худший исход среди позиций, чтобы вызывающий видел, что ещё не закрыто.
  const outcomes = results.map((r) => r.outcome);
  const pick = ['duplicate_code', 'rate_limited', 'retry_later', 'out_of_stock', 'delivery_failed', 'not_payable', 'locked']
    .find((o) => outcomes.includes(o));
  return { outcome: pick || (outcomes.every((o) => o === 'delivered' || o === 'already_delivered') ? 'delivered' : outcomes[0]), items: results };
}

/**
 * Пересчёт витринного остатка по фактическим складам поставщиков.
 * Единственный источник истины про наличие это поставщики, витрина только проекция.
 */
export async function syncStock(sku) {
  let total = 0;

  for (const supplier of suppliers()) {
    const items = await fetchStock(supplier, sku);
    if (items === null) {
      // Молчание поставщика это не ноль на его складе. Записать сумму по остальным значило бы
      // занизить витрину и спрятать товар, который на самом деле есть.
      log.warn('stock.sync_skipped', { sku, supplier: supplier.name, reason: 'no_response' });
      return null;
    }
    for (const item of items) if (!sku || item.sku === sku) total += Number(item.available || 0);
  }

  await pool.query(
    `INSERT INTO product_stock (sku, available) VALUES ($1, $2)
     ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
    [sku, total],
  );
  return total;
}

/** В логах должен быть след выдачи, но не сам товар. */
const maskCode = (code) => (typeof code === 'string' && code.length > 4 ? `***${code.slice(-4)}` : '***');

const backoffMs = (attempt) => Math.min(config.supplierBackoffBaseMs * 2 ** Math.min(attempt, 6), 30_000);
