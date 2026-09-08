import { query, withTx, isUniqueViolation, pool } from '../db.js';
import { config } from '../config.js';
import { newOrderId, orderItemId } from '../ids.js';
import { log } from '../logger.js';
import { EVENT, recordEvent } from './events.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_ITEMS = 50;

/**
 * Разбор состава заказа.
 * Первый этап присылал один `sku`, второй присылает `items`. Оба контракта живые:
 * заказ из одного товара это заказ из одной позиции, а не отдельная ветка кода.
 *
 * Количество разворачивается в отдельные позиции: каждая единица получает свой код
 * от своего поставщика и может не выдаться независимо от соседей.
 */
function parseItems(body) {
  if (Array.isArray(body?.items) && body.items.length > 0) {
    const lines = body.items.map((line, idx) => {
      const sku = line?.sku;
      const qty = line?.qty === undefined ? 1 : Number(line.qty);
      if (!sku || typeof sku !== 'string') throw new ApiError(400, 'bad_request', `items[${idx}].sku обязателен`);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ITEMS) {
        throw new ApiError(400, 'bad_request', `items[${idx}].qty: целое от 1 до ${MAX_ITEMS}`);
      }
      return { sku, qty };
    });
    const total = lines.reduce((s, l) => s + l.qty, 0);
    if (total > MAX_ITEMS) throw new ApiError(400, 'bad_request', `в заказе не больше ${MAX_ITEMS} позиций`);
    return lines;
  }

  if (body?.sku !== undefined) {
    if (!body.sku || typeof body.sku !== 'string') throw new ApiError(400, 'bad_request', 'sku обязателен');
    return [{ sku: body.sku, qty: 1 }];
  }

  throw new ApiError(400, 'bad_request', 'нужен sku или items');
}

/**
 * Создание заказа.
 * idempotency_key (необязательный) закрывает двойной клик "Купить": повторный запрос
 * с тем же ключом возвращает ТОТ ЖЕ заказ, а не создаёт второй.
 *
 * `reserve: true` разрешает начать выдачу до оплаты. Такие позиции обслуживаются
 * НИЖЕ оплаченных: под лимитом поставщика деньги покупателя важнее резерва.
 */
export async function createOrder({ sku, items, idempotencyKey = null, buyerContact = null, orderId = null, reserve = false }) {
  const lines = parseItems({ sku, items });

  if (orderId !== null && !/^[A-Za-z0-9_-]{3,64}$/.test(orderId)) {
    throw new ApiError(400, 'bad_request', 'order_id: 3-64 символа [A-Za-z0-9_-]');
  }

  const skus = [...new Set(lines.map((l) => l.sku))];
  const products = await query(
    'SELECT sku, price_minor, currency, is_active FROM products WHERE sku = ANY($1)', [skus]);
  const bySku = new Map(products.rows.map((r) => [r.sku, r]));

  for (const s of skus) {
    const p = bySku.get(s);
    if (!p) throw new ApiError(404, 'product_not_found', `Товар ${s} не найден`);
    if (!p.is_active) throw new ApiError(409, 'product_inactive', `Товар ${s} снят с продажи`);
  }

  const currencies = new Set(skus.map((s) => bySku.get(s).currency));
  if (currencies.size > 1) {
    throw new ApiError(400, 'mixed_currency', 'Все товары заказа должны быть в одной валюте');
  }
  const currency = [...currencies][0];

  // Позиции нумеруются по порядку строк и по количеству внутри строки.
  const positions = [];
  for (const line of lines) {
    for (let i = 0; i < line.qty; i++) {
      positions.push({ sku: line.sku, amount: Number(bySku.get(line.sku).price_minor) });
    }
  }
  const amount = positions.reduce((s, p) => s + p.amount, 0);

  // id можно задать снаружи: платёжная система получает его при инициализации платежа
  // и вправе прислать вебхук раньше, чем у нас закоммитится заказ.
  const id = orderId || newOrderId();
  // sku на уровне заказа остаётся только у заказа из одной позиции: контракт первого этапа.
  const headSku = positions.length === 1 ? positions[0].sku : null;

  try {
    return await withTx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO orders (id, sku, amount_minor, currency, status, idempotency_key, buyer_contact)
         VALUES ($1, $2, $3, $4, 'created', $5, $6)
         RETURNING *`,
        [id, headSku, amount, currency, idempotencyKey, buyerContact],
      );

      const created = [];
      for (const [idx, p] of positions.entries()) {
        const itemId = orderItemId(id, idx + 1);
        await client.query(
          `INSERT INTO order_items (id, order_id, position, sku, amount_minor, currency, status, priority, queued_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
          [itemId, id, idx + 1, p.sku, p.amount, currency, config.priority.unpaid, reserve ? new Date() : null],
        );
        created.push({ id: itemId, position: idx + 1, sku: p.sku, amount_minor: p.amount });
      }

      await recordEvent(client, {
        orderId: id,
        type: EVENT.orderCreated,
        amountMinor: amount,
        payload: { items: created, reserve, currency },
      });

      log.info('order.created', { order_id: id, items: created.length, amount_minor: amount, idempotency_key: idempotencyKey });
      return { order: rows[0], reused: false };
    });
  } catch (err) {
    if (isUniqueViolation(err) && err.constraint === 'orders_pkey') {
      const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
      if (rows.length) return { order: rows[0], reused: true };
    }
    if (isUniqueViolation(err) && idempotencyKey) {
      const { rows } = await query('SELECT * FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
      if (rows.length) {
        log.info('order.idempotent_hit', { order_id: rows[0].id, idempotency_key: idempotencyKey });
        return { order: rows[0], reused: true };
      }
    }
    throw err;
  }
}

export async function getOrder(id) {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
  if (rows.length === 0) throw new ApiError(404, 'order_not_found', `Заказ ${id} не найден`);

  const items = await query(
    `SELECT i.*, d.code, d.supplier, d.created_at AS delivered_code_at,
            r.status AS refund_status, r.amount_minor AS refund_amount_minor, r.settled_at AS refund_settled_at
       FROM order_items i
       LEFT JOIN deliveries d ON d.order_item_id = i.id
       LEFT JOIN refunds r    ON r.order_item_id = i.id
      WHERE i.order_id = $1
      ORDER BY i.position`,
    [id],
  );
  return { ...rows[0], items: items.rows };
}

/**
 * Публичное представление заказа.
 * Поля первого этапа сохранены: заказ из одной позиции отвечает ровно тем же телом,
 * плюс появляется разбивка по позициям и денежная сводка.
 */
export function serializeOrder(row) {
  const items = row.items || [];
  const head = items.length === 1 ? items[0] : null;

  const sum = (predicate) => items.filter(predicate).reduce((s, i) => s + Number(i.amount_minor), 0);
  const delivered = sum((i) => i.status === 'delivered');
  const refunded = sum((i) => i.status === 'refunded');
  const pendingRefund = sum((i) => i.status === 'unfulfillable' || (i.refund_status && i.refund_status !== 'settled'));

  return {
    id: row.id,
    sku: row.sku,
    amount: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    paid_at: row.paid_at,
    delivered_at: row.delivered_at,
    attempts: row.attempts,
    last_error: row.last_error,
    // Контракт первого этапа: у заказа из одной позиции delivery лежит на верхнем уровне.
    delivery: head && head.code
      ? { code: head.code, supplier: head.supplier, issued_at: head.delivered_code_at }
      : null,
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      sku: i.sku,
      amount: Number(i.amount_minor),
      status: i.status,
      attempts: i.attempts,
      last_error: i.last_error,
      delivery: i.code ? { code: i.code, supplier: i.supplier, issued_at: i.delivered_code_at } : null,
      refund: i.refund_status
        ? { status: i.refund_status, amount: Number(i.refund_amount_minor), settled_at: i.refund_settled_at }
        : null,
    })),
    money: {
      paid: row.paid_at ? Number(row.amount_minor) : 0,
      delivered,
      refunded,
      refund_pending: pendingRefund,
      // Деньги, судьба которых ещё не решена. У завершённого заказа обязан быть ноль.
      in_flight: (row.paid_at ? Number(row.amount_minor) : 0) - delivered - refunded - pendingRefund,
    },
  };
}

/** Пометить позицию восстановимым состоянием и назначить время следующей попытки. */
export async function markItemRecoverable(itemId, error, delayMs) {
  await pool.query(
    `UPDATE order_items
        SET status = 'pending',
            last_error = $2,
            next_attempt_at = now() + ($3 || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'delivering')`,
    [itemId, error, String(delayMs)],
  );
  log.debug('item.recoverable', { item_id: itemId, error, retry_in_ms: delayMs });
}

/**
 * Пересчёт статуса заказа по статусам его позиций.
 * Единственное место, где заказ получает своё состояние: иначе "частично выдан"
 * и "часть позиций ждёт завоза" пришлось бы поддерживать в каждой ветке кода.
 */
export async function refreshOrderStatus(orderId, client = null) {
  const runner = client || pool;
  const { rows } = await runner.query(
    `SELECT o.status AS order_status, o.paid_at,
            count(*)::int                                         AS total,
            count(*) FILTER (WHERE i.status = 'delivered')::int    AS delivered,
            count(*) FILTER (WHERE i.status = 'refunded')::int     AS refunded,
            count(*) FILTER (WHERE i.status = 'unfulfillable')::int AS unfulfillable,
            count(*) FILTER (WHERE i.status IN ('pending', 'delivering'))::int AS open,
            count(*) FILTER (WHERE i.status IN ('pending', 'delivering')
                               AND COALESCE(i.last_error, '') LIKE '%out_of_stock%')::int AS waiting_stock,
            count(*) FILTER (WHERE i.status IN ('pending', 'delivering')
                               AND i.last_error IS NOT NULL
                               AND i.last_error NOT LIKE '%out_of_stock%'
                               AND i.last_error NOT LIKE 'unknown:%'
                               AND i.last_error NOT LIKE 'rate_limited:%')::int AS failing
       FROM orders o JOIN order_items i ON i.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.status, o.paid_at`,
    [orderId],
  );
  if (rows.length === 0) return null;
  const s = rows[0];

  // Пока есть незакрытые позиции, итог не подводится, но состояние заказа обязано
  // честно отражать, чего он ждёт: завоза, повтора или просто выдачи.
  if (s.open > 0 || s.unfulfillable > 0) {
    if (!s.paid_at) return null;
    const waiting = s.waiting_stock > 0 ? 'out_of_stock'
      : s.failing > 0 ? 'delivery_failed'
      : 'delivering';
    // Время ближайшего повтора у заказа = ближайшее среди его позиций: аренда живёт на позициях,
    // но наблюдать за заказом должно быть можно, не разворачивая его состав.
    await runner.query(
      `UPDATE orders o
          SET status = CASE WHEN o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
                            THEN $2 ELSE o.status END,
              next_attempt_at = sub.next_attempt_at,
              updated_at = now()
         FROM (SELECT MIN(i.next_attempt_at) AS next_attempt_at
                 FROM order_items i
                WHERE i.order_id = $1 AND i.status IN ('pending', 'delivering')) sub
        WHERE o.id = $1
          AND (o.status IS DISTINCT FROM $2 OR o.next_attempt_at IS DISTINCT FROM sub.next_attempt_at)`,
      [orderId, waiting],
    );
    return null;
  }
  if (!s.paid_at) return null;

  const status = s.delivered === s.total ? 'delivered'
    : s.delivered === 0 ? 'refunded'
    : 'partially_delivered';

  const { rowCount } = await runner.query(
    `UPDATE orders
        SET status = $2,
            delivered_at = CASE WHEN $3 > 0 THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
            next_attempt_at = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1 AND status <> $2`,
    [orderId, status, s.delivered],
  );

  if (rowCount > 0) {
    await recordEvent(runner, {
      orderId,
      type: EVENT.orderFinalized,
      payload: { status, delivered: s.delivered, refunded: s.refunded, total: s.total },
    });
    log.info('order.finalized', { order_id: orderId, status, delivered: s.delivered, refunded: s.refunded });
  }
  return status;
}

/** Совместимость с первым этапом: пометка восстановимого состояния на уровне заказа. */
export async function markRecoverable(orderId, status, error, delayMs) {
  await pool.query(
    `UPDATE orders
        SET status = $2, last_error = $3,
            next_attempt_at = now() + ($4 || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1 AND status NOT IN ('delivered', 'partially_delivered', 'refunded')`,
    [orderId, status, error, String(delayMs)],
  );
  log.warn('order.recoverable', { order_id: orderId, status, error, retry_in_ms: delayMs });
}
