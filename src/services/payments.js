import { pool, withTx } from '../db.js';
import { log } from '../logger.js';
import { recordPayment } from './ledger.js';
import { ApiError } from './orders.js';

const VALID_STATUSES = new Set(['paid', 'failed']);

/**
 * Приём вебхука платёжной системы.
 *
 * Гарантии, которые закладывает контракт (at-least-once, порядок не гарантирован):
 *   - повтор с тем же event_id -> PRIMARY KEY не даст обработать дважды;
 *   - вебхук раньше заказа     -> событие сохраняется как необработанное и применится при создании заказа;
 *   - вебхук не по порядку     -> событие старше уже применённого просто игнорируется.
 *
 * Отвечаем быстро: выдача запускается вне обработчика.
 */
export async function handlePaymentWebhook(payload) {
  const eventId = payload?.event_id;
  const orderId = payload?.order_id;
  const status = payload?.status;

  if (!eventId || !orderId || !VALID_STATUSES.has(status)) {
    throw new ApiError(400, 'bad_webhook', 'event_id, order_id и status (paid|failed) обязательны');
  }

  const occurredAt = payload.created_at ? new Date(payload.created_at) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new ApiError(400, 'bad_webhook', 'created_at не разбирается');

  const amountMinor = payload.amount === undefined || payload.amount === null ? null : Number(payload.amount);

  const insert = await pool.query(
    `INSERT INTO payment_events (event_id, order_id, status, amount_minor, currency, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, orderId, status, amountMinor, payload.currency ?? null, occurredAt.toISOString()],
  );

  if (insert.rowCount === 0) {
    log.info('webhook.duplicate', { event_id: eventId, order_id: orderId });
    return { accepted: true, duplicate: true, outcome: 'duplicate' };
  }

  const applied = await applyEvent(eventId);
  log.info('webhook.accepted', { event_id: eventId, order_id: orderId, status, outcome: applied.outcome });
  return { accepted: true, duplicate: false, ...applied };
}

/** Применить одно сохранённое событие к заказу. Возвращает outcome и признак "надо выдавать". */
export async function applyEvent(eventId) {
  return withTx(async (client) => {
    const ev = await client.query('SELECT * FROM payment_events WHERE event_id = $1 FOR UPDATE', [eventId]);
    if (ev.rowCount === 0) return { outcome: 'event_not_found' };
    const event = ev.rows[0];
    if (event.processed_at) return { outcome: event.outcome || 'already_processed' };

    const ord = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [event.order_id]);
    if (ord.rowCount === 0) {
      // Заказа ещё нет. Событие остаётся необработанным и будет применено при создании заказа.
      await client.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [eventId, 'order_not_found']);
      log.warn('webhook.order_not_found_yet', { event_id: eventId, order_id: event.order_id });
      return { outcome: 'pending_order' };
    }
    const order = ord.rows[0];

    const finish = async (outcome, { touchEventClock = true } = {}) => {
      await client.query('UPDATE payment_events SET processed_at = now(), outcome = $2 WHERE event_id = $1', [eventId, outcome]);
      if (touchEventClock) {
        await client.query(
          `UPDATE orders SET last_payment_event_at = GREATEST(COALESCE(last_payment_event_at, 'epoch'::timestamptz), $2), updated_at = now()
            WHERE id = $1`,
          [order.id, event.occurred_at],
        );
      }
      return outcome;
    };

    // Событие старше уже применённого, игнорируем (вебхуки приходят не по порядку).
    if (order.last_payment_event_at && event.occurred_at <= order.last_payment_event_at) {
      log.info('webhook.stale', { event_id: eventId, order_id: order.id });
      return { outcome: await finish('stale', { touchEventClock: false }) };
    }

    if (event.amount_minor !== null && Number(event.amount_minor) !== Number(order.amount_minor)) {
      log.error('webhook.amount_mismatch', {
        event_id: eventId, order_id: order.id,
        expected_minor: order.amount_minor, got_minor: event.amount_minor,
      });
      return { outcome: await finish('amount_mismatch', { touchEventClock: false }) };
    }

    if (event.status === 'paid') {
      if (order.status === 'created' || order.status === 'payment_failed') {
        await client.query(
          `UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, now()), last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [order.id],
        );
        await recordPayment(client, order.id, order.amount_minor);
        log.info('payment.applied', { event_id: eventId, order_id: order.id, amount_minor: order.amount_minor });
        return { outcome: await finish('applied'), deliver: true, orderId: order.id };
      }
      // Уже оплачен: повторное "оплачено" ничего не меняет, но выдачу подтолкнуть стоит.
      return { outcome: await finish('already_paid'), deliver: order.status !== 'delivered', orderId: order.id };
    }

    // status === 'failed'
    if (order.status === 'created') {
      await client.query(
        `UPDATE orders SET status = 'payment_failed', last_error = 'payment_failed', updated_at = now() WHERE id = $1`,
        [order.id],
      );
      log.info('payment.failed', { event_id: eventId, order_id: order.id });
      return { outcome: await finish('applied') };
    }

    // Отказ после успешной оплаты это возврат или чарджбэк, он вне контура задания.
    log.warn('webhook.failed_after_paid', { event_id: eventId, order_id: order.id, status: order.status });
    return { outcome: await finish('ignored_after_paid') };
  });
}

/**
 * Применить события, пришедшие раньше заказа.
 * Вызывается сразу после создания заказа и фоновым воркером.
 */
export async function applyPendingEvents(orderId) {
  const { rows } = await pool.query(
    `SELECT event_id FROM payment_events
      WHERE order_id = $1 AND processed_at IS NULL
      ORDER BY occurred_at, received_at`,
    [orderId],
  );
  const results = [];
  for (const row of rows) results.push(await applyEvent(row.event_id));
  return results;
}
