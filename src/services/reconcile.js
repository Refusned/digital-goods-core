import { pool } from '../db.js';
import { ledgerBalance } from './ledger.js';

/**
 * Сверка. Два вопроса, на которые магазин обязан отвечать в любой момент:
 * что оплачено, но не выдано, и что выдано, но не оплачено.
 */
export async function reconciliationReport({ limit = 100 } = {}) {
  const paidNotDelivered = await pool.query(
    `SELECT o.id, o.sku, o.status, o.amount_minor, o.paid_at, o.attempts, o.last_error, o.next_attempt_at
       FROM orders o
       LEFT JOIN deliveries d ON d.order_id = o.id
      WHERE o.paid_at IS NOT NULL
        AND d.order_id IS NULL
        AND o.status <> 'payment_failed'
      ORDER BY o.paid_at
      LIMIT $1`,
    [limit],
  );

  const deliveredNotPaid = await pool.query(
    `SELECT o.id, o.sku, o.status, o.amount_minor, d.code, d.supplier, d.created_at AS delivered_at
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
      WHERE o.paid_at IS NULL
      ORDER BY d.created_at
      LIMIT $1`,
    [limit],
  );

  // События, для которых заказа так и не появилось: платёж есть, продажи нет.
  const orphanEvents = await pool.query(
    `SELECT event_id, order_id, status, amount_minor, occurred_at, received_at
       FROM payment_events
      WHERE processed_at IS NULL
      ORDER BY received_at
      LIMIT $1`,
    [limit],
  );

  // Заказ висит в выдаче, судьба запроса к поставщику неизвестна (таймаут).
  const unknownSupplierCalls = await pool.query(
    `SELECT sr.request_id, sr.order_id, sr.supplier, sr.attempts, sr.updated_at
       FROM supplier_requests sr
       JOIN orders o ON o.id = sr.order_id
      WHERE sr.state = 'unknown' AND o.status <> 'delivered'
      ORDER BY sr.updated_at
      LIMIT $1`,
    [limit],
  );

  const money = await ledgerBalance(pool);

  return {
    generated_at: new Date().toISOString(),
    paid_not_delivered: { count: paidNotDelivered.rowCount, items: paidNotDelivered.rows },
    delivered_not_paid: { count: deliveredNotPaid.rowCount, items: deliveredNotPaid.rows },
    payment_events_without_order: { count: orphanEvents.rowCount, items: orphanEvents.rows },
    supplier_calls_unknown: { count: unknownSupplierCalls.rowCount, items: unknownSupplierCalls.rows },
    ledger: money,
    healthy:
      deliveredNotPaid.rowCount === 0 && money.balanced,
  };
}
