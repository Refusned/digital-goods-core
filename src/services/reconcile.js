import { pool } from '../db.js';
import { ledgerBalance, moneyPerOrder } from './ledger.js';

/**
 * Сверка. Вопросы, на которые магазин обязан отвечать в любой момент:
 * что оплачено, но не выдано; что выдано, но не оплачено; и сходятся ли деньги.
 *
 * Во втором этапе сверка ведётся по ПОЗИЦИЯМ, а не по заказам: частично выданный заказ
 * это нормальное конечное состояние, а вот отдельная позиция, за которую взяли деньги
 * и ничего не дали, это дыра.
 */
export async function reconciliationReport({ limit = 100, overdueSeconds = 60 } = {}) {
  // Оплаченные позиции без выдачи и без начисленного возврата: деньги взяты, судьба не решена.
  const paidNotDelivered = await pool.query(
    `SELECT o.id, i.id AS item_id, i.sku, i.status AS item_status, o.status, i.amount_minor,
            o.paid_at, i.attempts, i.last_error, i.next_attempt_at, i.deadline_at
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
       LEFT JOIN deliveries d ON d.order_item_id = i.id
       LEFT JOIN refunds r ON r.order_item_id = i.id
      WHERE o.paid_at IS NOT NULL
        AND d.order_item_id IS NULL
        AND r.id IS NULL
        AND o.status <> 'payment_failed'
      ORDER BY o.paid_at
      LIMIT $1`,
    [limit],
  );

  const deliveredNotPaid = await pool.query(
    `SELECT o.id, d.order_item_id, i.sku, o.status, i.amount_minor, d.code, d.supplier, d.created_at AS delivered_at
       FROM deliveries d
       JOIN order_items i ON i.id = d.order_item_id
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

  // Позиция висит в выдаче, судьба запроса к поставщику неизвестна (таймаут).
  const unknownSupplierCalls = await pool.query(
    `SELECT sr.request_id, sr.order_id, sr.order_item_id, sr.supplier, sr.attempts, sr.updated_at
       FROM supplier_requests sr
       JOIN order_items i ON i.id = sr.order_item_id
      WHERE sr.state = 'unknown' AND i.status NOT IN ('delivered', 'refunded')
      ORDER BY sr.updated_at
      LIMIT $1`,
    [limit],
  );

  // Возвраты, которые начислены, но ещё не выплачены.
  const openRefunds = await pool.query(
    `SELECT id, order_id, order_item_id, amount_minor, status, attempts, reason, created_at, last_error
       FROM refunds WHERE status <> 'settled' ORDER BY created_at LIMIT $1`,
    [limit],
  );

  // Отбракованные коды, которые ещё не вернулись на склад поставщика.
  const heldCodes = await pool.query(
    `SELECT request_id, supplier, order_item_id, rejected_code, updated_at
       FROM supplier_requests WHERE state = 'rejected' AND released_at IS NULL
      ORDER BY updated_at LIMIT $1`,
    [limit],
  );

  const money = await ledgerBalance(pool);
  // Заказы, где деньги не сходятся: выдано плюс возвращено больше, чем оплачено.
  const brokenMoney = await moneyPerOrder(pool, { onlyBroken: true, limit });

  const totals = await pool.query(
    `SELECT
       (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id
          LEFT JOIN deliveries d ON d.order_item_id = i.id
          LEFT JOIN refunds r ON r.order_item_id = i.id
         WHERE o.paid_at IS NOT NULL AND d.order_item_id IS NULL AND r.id IS NULL
           AND o.status <> 'payment_failed')::int AS paid_not_delivered,
       (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id
          LEFT JOIN deliveries d ON d.order_item_id = i.id
          LEFT JOIN refunds r ON r.order_item_id = i.id
         WHERE o.paid_at IS NOT NULL AND d.order_item_id IS NULL AND r.id IS NULL
           AND o.status <> 'payment_failed'
           AND o.paid_at < now() - ($1 || ' seconds')::interval)::int AS paid_not_delivered_overdue,
       (SELECT count(*) FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE o.paid_at IS NULL)::int AS delivered_not_paid,
       (SELECT count(*) FROM payment_events WHERE processed_at IS NULL)::int AS events_without_order,
       (SELECT count(*) FROM supplier_requests sr JOIN order_items i ON i.id = sr.order_item_id
         WHERE sr.state = 'unknown' AND i.status NOT IN ('delivered', 'refunded'))::int AS supplier_unknown,
       (SELECT count(*) FROM refunds WHERE status <> 'settled')::int AS refunds_open,
       (SELECT count(*) FROM refunds WHERE status = 'failed')::int AS refunds_failed,
       (SELECT count(*) FROM supplier_discrepancies WHERE resolved_at IS NULL)::int AS discrepancies_open,
       (SELECT count(*) FROM supplier_requests WHERE state = 'rejected' AND released_at IS NULL)::int AS codes_held`,
    [String(overdueSeconds)],
  );
  const t = totals.rows[0];

  return {
    generated_at: new Date().toISOString(),
    paid_not_delivered: { count: t.paid_not_delivered, overdue: t.paid_not_delivered_overdue, items: paidNotDelivered.rows },
    delivered_not_paid: { count: t.delivered_not_paid, items: deliveredNotPaid.rows },
    payment_events_without_order: { count: t.events_without_order, items: orphanEvents.rows },
    supplier_calls_unknown: { count: t.supplier_unknown, items: unknownSupplierCalls.rows },
    refunds_open: { count: t.refunds_open, failed: t.refunds_failed, items: openRefunds.rows },
    supplier_codes_held: { count: t.codes_held, items: heldCodes.rows },
    supplier_discrepancies_open: t.discrepancies_open,
    ledger: money,
    // Главный денежный инвариант второго этапа: по каждому заказу
    // оплачено = выдано + возвращено + ещё в работе, и последнее слагаемое не бывает отрицательным.
    money_per_order_broken: brokenMoney,
    // Бухгалтерия и операционное состояние это разные вопросы, и мешать их нельзя:
    // журнал может идеально сходиться ровно в тот момент, когда клиент не получил товар.
    ledger_balanced: money.balanced,
    healthy:
      t.delivered_not_paid === 0 &&
      money.balanced &&
      brokenMoney.length === 0 &&
      t.paid_not_delivered_overdue === 0 &&
      t.events_without_order === 0 &&
      t.supplier_unknown === 0 &&
      t.refunds_failed === 0,
    health_details: {
      delivered_not_paid: t.delivered_not_paid,
      paid_not_delivered_overdue: t.paid_not_delivered_overdue,
      overdue_after_seconds: overdueSeconds,
      payment_events_without_order: t.events_without_order,
      supplier_calls_unknown: t.supplier_unknown,
      refunds_failed: t.refunds_failed,
      money_per_order_broken: brokenMoney.length,
      ledger_balanced: money.balanced,
    },
  };
}
