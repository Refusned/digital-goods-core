import { pool } from '../db.js';
import { ledgerBalance } from './ledger.js';

/**
 * Сверка. Два вопроса, на которые магазин обязан отвечать в любой момент:
 * что оплачено, но не выдано, и что выдано, но не оплачено.
 */
export async function reconciliationReport({ limit = 100, overdueSeconds = 60 } = {}) {
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

  // Полные счётчики считаем отдельно: списки выше ограничены LIMIT и на здоровье влиять не могут.
  const totals = await pool.query(
    `SELECT
       (SELECT count(*) FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
         WHERE o.paid_at IS NOT NULL AND d.order_id IS NULL AND o.status <> 'payment_failed')::int AS paid_not_delivered,
       (SELECT count(*) FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
         WHERE o.paid_at IS NOT NULL AND d.order_id IS NULL AND o.status <> 'payment_failed'
           AND o.paid_at < now() - ($1 || ' seconds')::interval)::int AS paid_not_delivered_overdue,
       (SELECT count(*) FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE o.paid_at IS NULL)::int AS delivered_not_paid,
       (SELECT count(*) FROM payment_events WHERE processed_at IS NULL)::int AS events_without_order,
       (SELECT count(*) FROM supplier_requests sr JOIN orders o ON o.id = sr.order_id
         WHERE sr.state = 'unknown' AND o.status <> 'delivered')::int AS supplier_unknown`,
    [String(overdueSeconds)],
  );
  const t = totals.rows[0];

  return {
    generated_at: new Date().toISOString(),
    paid_not_delivered: { count: t.paid_not_delivered, overdue: t.paid_not_delivered_overdue, items: paidNotDelivered.rows },
    delivered_not_paid: { count: t.delivered_not_paid, items: deliveredNotPaid.rows },
    payment_events_without_order: { count: t.events_without_order, items: orphanEvents.rows },
    supplier_calls_unknown: { count: t.supplier_unknown, items: unknownSupplierCalls.rows },
    ledger: money,
    // Бухгалтерия и операционное состояние это разные вопросы, и мешать их нельзя:
    // журнал может идеально сходиться ровно в тот момент, когда клиент не получил товар.
    ledger_balanced: money.balanced,
    healthy:
      t.delivered_not_paid === 0 &&
      money.balanced &&
      t.paid_not_delivered_overdue === 0 &&
      t.events_without_order === 0 &&
      t.supplier_unknown === 0,
    health_details: {
      delivered_not_paid: t.delivered_not_paid,
      paid_not_delivered_overdue: t.paid_not_delivered_overdue,
      overdue_after_seconds: overdueSeconds,
      payment_events_without_order: t.events_without_order,
      supplier_calls_unknown: t.supplier_unknown,
      ledger_balanced: money.balanced,
    },
  };
}
