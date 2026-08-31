import { pool, withTx, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { supplierRequestId } from '../ids.js';
import { log } from '../logger.js';
import { issue, fetchStock } from '../suppliers/client.js';
import { recordDelivery } from './ledger.js';
import { markRecoverable } from './orders.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORDER_STATES_TO_DELIVER = ['paid', 'delivering', 'out_of_stock', 'delivery_failed'];

/**
 * Довести заказ до выданного кода. Функция идемпотентна и безопасна к параллельному вызову:
 * её одновременно дёргают обработчик вебхука и фоновый воркер.
 *
 * Три уровня защиты от двойной выдачи:
 *   1. сессионный advisory lock по заказу: параллельные попытки просто расходятся;
 *   2. детерминированный request_id: повтор к поставщику возвращает ТОТ ЖЕ код;
 *   3. deliveries.order_id PRIMARY KEY: вторая строка выдачи физически не вставится.
 */
export async function deliverOrder(orderId, { trigger = 'unknown' } = {}) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok', [orderId]);
    locked = lock.rows[0].ok;
    if (!locked) {
      log.debug('delivery.skip_locked', { order_id: orderId, trigger });
      return { outcome: 'locked' };
    }

    const { rows } = await pool.query(
      `SELECT o.*, d.code AS delivered_code
         FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
        WHERE o.id = $1`,
      [orderId],
    );
    if (rows.length === 0) return { outcome: 'order_not_found' };
    const order = rows[0];

    if (order.delivered_code) {
      // Выдача уже есть. Дотягиваем статус, если прошлый заход упал между INSERT и UPDATE.
      await pool.query(
        `UPDATE orders SET status = 'delivered', delivered_at = COALESCE(delivered_at, now()), next_attempt_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'delivered'`,
        [orderId],
      );
      return { outcome: 'already_delivered', code: order.delivered_code };
    }

    if (!ORDER_STATES_TO_DELIVER.includes(order.status)) {
      log.debug('delivery.skip_status', { order_id: orderId, status: order.status, trigger });
      return { outcome: 'not_payable', status: order.status };
    }

    // next_attempt_at здесь НЕ обнуляется: это аренда задачи, выданная воркером,
    // и она должна действовать всё время сетевых вызовов. Снимается только в финале.
    await pool.query(
      `UPDATE orders SET status = 'delivering', attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [orderId],
    );

    // Отказ поставщика действует в пределах одной попытки. На новой попытке
    // поставщик снова доступен для обращения: "нет остатка" и 5xx это состояния временные.
    // Записи 'ok' и 'unknown' не трогаем: они несут судьбу уже отправленного запроса.
    await pool.query(
      `UPDATE supplier_requests SET state = 'retryable', updated_at = now()
        WHERE order_id = $1 AND state = 'failed'`,
      [orderId],
    );

    const result = await acquireCode(order);

    if (result.outcome === 'ok') {
      const delivered = await finalizeDelivery(order, result);
      // Витрина обязана показывать реальный остаток поставщиков, а не собственную догадку.
      await syncStock(order.sku);
      return delivered;
    }

    if (result.outcome === 'retry_later') {
      // Таймаут: поставщик мог выдать код. Уходить на резервного нельзя, только повторять к нему же.
      await markRecoverable(orderId, 'delivering', `timeout:${result.supplier}`, backoffMs(order.attempts + 1));
      return { outcome: 'retry_later' };
    }

    const outOfStock = result.reasons.some((r) => String(r.reason).includes('out_of_stock'));
    if (outOfStock) await syncStock(order.sku);

    await markRecoverable(
      orderId,
      outOfStock ? 'out_of_stock' : 'delivery_failed',
      result.reasons.map((r) => `${r.supplier}:${r.reason}`).join(', '),
      outOfStock ? config.worker.outOfStockRetryMs : backoffMs(order.attempts + 1),
    );
    return { outcome: outOfStock ? 'out_of_stock' : 'delivery_failed', reasons: result.reasons };
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [orderId]).catch(() => {});
    lockClient.release();
  }
}

/**
 * Получить код у поставщиков.
 * Порядок: сначала основной A, потом резервный B, но ТОЛЬКО если A дал явный отказ.
 */
async function acquireCode(order) {
  const reasons = [];

  for (const supplier of [config.suppliers.a, config.suppliers.b]) {
    const requestId = supplierRequestId(order.id, supplier.name);

    const known = await pool.query('SELECT state, code, reason FROM supplier_requests WHERE request_id = $1', [requestId]);
    const prev = known.rows[0];

    if (prev?.state === 'ok' && prev.code) {
      // Код у нас уже есть с прошлого захода, второй раз к поставщику не идём.
      return { outcome: 'ok', code: prev.code, supplier: supplier.name, requestId };
    }
    if (prev?.state === 'failed') {
      reasons.push({ supplier: supplier.name, reason: prev.reason });
      continue; // явный отказ, резервный поставщик разрешён
    }

    await upsertSupplierRequest(requestId, order.id, supplier.name, 'in_flight');

    let last = null;
    for (let attempt = 1; attempt <= config.supplierMaxAttempts; attempt++) {
      last = await issue(supplier, { requestId, sku: order.sku, orderId: order.id }, {});

      if (last.outcome === 'ok') {
        await upsertSupplierRequest(requestId, order.id, supplier.name, 'ok', { code: last.code, attempts: attempt });
        return { outcome: 'ok', code: last.code, supplier: supplier.name, requestId };
      }

      if (last.outcome === 'failed') {
        // 5xx это временная беда поставщика: повторяем к нему же с тем же request_id и бэкоффом.
        // Контрактный отказ (4xx, нет остатка, недоступен) разбирать смысла нет, уходим к резервному.
        if (last.retryable && attempt < config.supplierMaxAttempts) {
          await upsertSupplierRequest(requestId, order.id, supplier.name, 'retryable', { reason: last.reason, attempts: attempt });
          await sleep(config.supplierBackoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        await upsertSupplierRequest(requestId, order.id, supplier.name, 'failed', { reason: last.reason, attempts: attempt });
        reasons.push({ supplier: supplier.name, reason: last.reason });
        break;
      }

      // unknown: повторяем с ТЕМ ЖЕ request_id, поставщик обязан вернуть тот же код
      await upsertSupplierRequest(requestId, order.id, supplier.name, 'unknown', { reason: last.reason, attempts: attempt });
      if (attempt < config.supplierMaxAttempts) await sleep(config.supplierBackoffBaseMs * 2 ** (attempt - 1));
    }

    if (last?.outcome === 'unknown') {
      // Судьба запроса неизвестна: резервный поставщик запрещён, иначе получим две выдачи.
      return { outcome: 'retry_later', supplier: supplier.name, reasons };
    }
  }

  return { outcome: 'failed', reasons };
}

async function upsertSupplierRequest(requestId, orderId, supplier, state, { code = null, reason = null, attempts = 0 } = {}) {
  await pool.query(
    `INSERT INTO supplier_requests (request_id, order_id, supplier, state, code, reason, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (request_id) DO UPDATE
        SET state = EXCLUDED.state,
            code = COALESCE(EXCLUDED.code, supplier_requests.code),
            reason = EXCLUDED.reason,
            attempts = GREATEST(supplier_requests.attempts, EXCLUDED.attempts),
            updated_at = now()`,
    [requestId, orderId, supplier, state, code, reason, attempts],
  );
}

/** Запись факта выдачи, статуса, проводки и остатка одной транзакцией. */
async function finalizeDelivery(order, { code, supplier, requestId }) {
  return withTx(async (client) => {
    await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [order.id]);

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO deliveries (order_id, code, supplier, request_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id) DO NOTHING
         RETURNING order_id`,
        [order.id, code, supplier, requestId],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Код уже привязан к ДРУГОМУ заказу. Дальше не идём: лучше восстановимое состояние, чем задвоенная выдача.
        log.error('delivery.code_collision', { order_id: order.id, code, supplier });
        throw Object.assign(new Error('code_collision'), { code_collision: true });
      }
      throw err;
    }

    if (inserted.rowCount === 0) {
      const existing = await client.query('SELECT code FROM deliveries WHERE order_id = $1', [order.id]);
      log.info('delivery.already_present', { order_id: order.id, code: existing.rows[0]?.code });
      return { outcome: 'already_delivered', code: existing.rows[0]?.code };
    }

    await client.query(
      `UPDATE orders
          SET status = 'delivered', delivered_at = now(), last_error = NULL, next_attempt_at = NULL, updated_at = now()
        WHERE id = $1`,
      [order.id],
    );
    await recordDelivery(client, order.id, order.amount_minor);

    log.info('delivery.done', {
      order_id: order.id, sku: order.sku, supplier, request_id: requestId, code: maskCode(code),
    });
    return { outcome: 'delivered', code, supplier };
  }).catch(async (err) => {
    if (err.code_collision) {
      await markRecoverable(order.id, 'delivery_failed', 'code_collision', 60_000);
      return { outcome: 'delivery_failed', reasons: [{ supplier, reason: 'code_collision' }] };
    }
    throw err;
  });
}

/**
 * Пересчёт витринного остатка по фактическим складам поставщиков.
 * Единственный источник истины про наличие это поставщики, витрина только проекция.
 */
export async function syncStock(sku) {
  let total = 0;

  for (const supplier of [config.suppliers.a, config.suppliers.b]) {
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
