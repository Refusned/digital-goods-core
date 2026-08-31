import { query, withTx, isUniqueViolation } from '../db.js';
import { newOrderId } from '../ids.js';
import { log } from '../logger.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Создание заказа.
 * idempotency_key (необязательный) закрывает двойной клик "Купить": повторный запрос
 * с тем же ключом возвращает ТОТ ЖЕ заказ, а не создаёт второй.
 */
export async function createOrder({ sku, idempotencyKey = null, buyerContact = null, orderId = null }) {
  if (!sku || typeof sku !== 'string') throw new ApiError(400, 'bad_request', 'sku обязателен');
  if (orderId !== null && !/^[A-Za-z0-9_-]{3,64}$/.test(orderId)) {
    throw new ApiError(400, 'bad_request', 'order_id: 3-64 символа [A-Za-z0-9_-]');
  }

  const product = await query('SELECT sku, price_minor, currency, is_active FROM products WHERE sku = $1', [sku]);
  if (product.rowCount === 0) throw new ApiError(404, 'product_not_found', `Товар ${sku} не найден`);
  if (!product.rows[0].is_active) throw new ApiError(409, 'product_inactive', `Товар ${sku} снят с продажи`);

  const { price_minor: amount, currency } = product.rows[0];
  // id можно задать снаружи: платёжная система получает его при инициализации платежа
  // и вправе прислать вебхук раньше, чем у нас закоммитится заказ.
  const id = orderId || newOrderId();

  try {
    const { rows } = await query(
      `INSERT INTO orders (id, sku, amount_minor, currency, status, idempotency_key, buyer_contact)
       VALUES ($1, $2, $3, $4, 'created', $5, $6)
       RETURNING *`,
      [id, sku, amount, currency, idempotencyKey, buyerContact],
    );
    log.info('order.created', { order_id: id, sku, amount_minor: amount, idempotency_key: idempotencyKey });
    return { order: rows[0], reused: false };
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
  const { rows } = await query(
    `SELECT o.*,
            d.code       AS delivery_code,
            d.supplier   AS delivery_supplier,
            d.created_at AS delivered_code_at
       FROM orders o
       LEFT JOIN deliveries d ON d.order_id = o.id
      WHERE o.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new ApiError(404, 'order_not_found', `Заказ ${id} не найден`);
  return rows[0];
}

/** Публичное представление заказа: код показываем только когда он реально выдан. */
export function serializeOrder(row) {
  return {
    id: row.id,
    sku: row.sku,
    amount: row.amount_minor,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    paid_at: row.paid_at,
    delivered_at: row.delivered_at,
    attempts: row.attempts,
    last_error: row.last_error,
    delivery: row.delivery_code
      ? { code: row.delivery_code, supplier: row.delivery_supplier, issued_at: row.delivered_code_at }
      : null,
  };
}

/** Пометить заказ восстановимым состоянием и назначить время следующей попытки. */
export async function markRecoverable(orderId, status, error, delayMs) {
  await withTx(async (client) => {
    await client.query(
      `UPDATE orders
          SET status = $2,
              last_error = $3,
              next_attempt_at = now() + ($4 || ' milliseconds')::interval,
              updated_at = now()
        WHERE id = $1
          AND status <> 'delivered'`,
      [orderId, status, error, String(delayMs)],
    );
  });
  log.warn('order.recoverable', { order_id: orderId, status, error, retry_in_ms: delayMs });
}
