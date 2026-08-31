import { pool, withTx } from '../db.js';
import { log } from '../logger.js';
import { recordPayment } from './ledger.js';
import { ApiError } from './orders.js';

const VALID_STATUSES = new Set(['paid', 'failed']);
const ID_RE = /^[\w.:-]{1,128}$/;

/**
 * Разбор и строгая проверка контракта платёжной системы.
 * Денежные поля обязательны: событие без суммы или валюты не может оплатить заказ,
 * и это ошибка интеграции (400), а не повод отдать товар.
 */
function parseWebhook(payload) {
  const eventId = payload?.event_id;
  const orderId = payload?.order_id;
  const status = payload?.status;

  if (typeof eventId !== 'string' || !ID_RE.test(eventId)) throw new ApiError(400, 'bad_webhook', 'event_id: непустая строка до 128 символов');
  if (typeof orderId !== 'string' || !ID_RE.test(orderId)) throw new ApiError(400, 'bad_webhook', 'order_id: непустая строка до 128 символов');
  if (!VALID_STATUSES.has(status)) throw new ApiError(400, 'bad_webhook', 'status: paid или failed');

  if (typeof payload.created_at !== 'string' || payload.created_at.trim() === '') {
    throw new ApiError(400, 'bad_webhook', 'created_at: строка с датой в ISO 8601');
  }
  const occurredAt = new Date(payload.created_at);
  if (Number.isNaN(occurredAt.getTime())) throw new ApiError(400, 'bad_webhook', 'created_at не разбирается как дата');

  // Для оплаты сумма и валюта обязательны: без них сверить платёж не с чем.
  let amountMinor = null;
  let currency = null;
  if (status === 'paid') {
    amountMinor = payload.amount;
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new ApiError(400, 'bad_webhook', 'amount: целое число, не меньше нуля');
    }
    currency = payload.currency;
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
      throw new ApiError(400, 'bad_webhook', 'currency: код из трёх букв');
    }
    currency = currency.toUpperCase();
  } else {
    // Для failed сумма и валюта тоже обязательны: контракт платёжной системы содержит их всегда,
    // и молчаливый приём неполного события прячет ошибку интеграции.
    if (typeof payload.amount !== 'number' || !Number.isSafeInteger(payload.amount) || payload.amount < 0) {
      throw new ApiError(400, 'bad_webhook', 'amount: целое число, не меньше нуля');
    }
    if (typeof payload.currency !== 'string' || !/^[A-Za-z]{3}$/.test(payload.currency)) {
      throw new ApiError(400, 'bad_webhook', 'currency: код из трёх букв');
    }
    amountMinor = payload.amount;
    currency = payload.currency.toUpperCase();
  }

  return { eventId, orderId, status, occurredAt, amountMinor, currency };
}

/**
 * Приём вебхука платёжной системы.
 *
 * Гарантии, которые закладывает контракт (at-least-once, порядок не гарантирован):
 *   - повтор с тем же event_id: PRIMARY KEY не даст обработать дважды;
 *   - вебхук раньше заказа: событие сохраняется как необработанное и применится при создании заказа;
 *   - вебхук не по порядку: итог не зависит от порядка доставки, см. applyEvent.
 *
 * Отвечаем быстро: выдача запускается вне обработчика.
 */
export async function handlePaymentWebhook(payload) {
  const { eventId, orderId, status, occurredAt, amountMinor, currency } = parseWebhook(payload);

  const insert = await pool.query(
    `INSERT INTO payment_events (event_id, order_id, status, amount_minor, currency, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, orderId, status, amountMinor, currency, occurredAt.toISOString()],
  );

  if (insert.rowCount === 0) {
    log.info('webhook.duplicate', { event_id: eventId, order_id: orderId });
    return { accepted: true, duplicate: true, outcome: 'duplicate' };
  }

  const applied = await applyEvent(eventId);
  log.info('webhook.accepted', { event_id: eventId, order_id: orderId, status, outcome: applied.outcome });
  return { accepted: true, duplicate: false, ...applied };
}

/**
 * Применение одного сохранённого события к заказу.
 *
 * Политика намеренно НЕ зависит от порядка доставки и от времени событий:
 * успешная оплата монотонна и доминирует над отказом. Любая перестановка одного и того же
 * набора событий даёт одинаковый итог.
 *   paid   применяется, пока заказ не оплачен; на оплаченном заказе это no-op;
 *   failed применяется, только если успешной оплаты ещё не было.
 */
export async function applyEvent(eventId) {
  return withTx(async (client) => {
    const ev = await client.query('SELECT * FROM payment_events WHERE event_id = $1 FOR UPDATE', [eventId]);
    if (ev.rowCount === 0) return { outcome: 'event_not_found' };
    const event = ev.rows[0];
    if (event.processed_at) return { outcome: event.outcome || 'already_processed' };

    const ord = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [event.order_id]);
    if (ord.rowCount === 0) {
      // Заказа ещё нет. Событие остаётся необработанным и применится при создании заказа.
      await client.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [eventId, 'order_not_found']);
      log.warn('webhook.order_not_found_yet', { event_id: eventId, order_id: event.order_id });
      return { outcome: 'pending_order' };
    }
    const order = ord.rows[0];

    const finish = async (outcome) => {
      await client.query('UPDATE payment_events SET processed_at = now(), outcome = $2 WHERE event_id = $1', [eventId, outcome]);
      await client.query(
        `UPDATE orders SET last_payment_event_at = GREATEST(COALESCE(last_payment_event_at, 'epoch'::timestamptz), $2), updated_at = now()
          WHERE id = $1`,
        [order.id, event.occurred_at],
      );
      return outcome;
    };

    // Сверяем деньги: и сумму, и валюту. Расхождение это ошибка интеграции, товар за него не отдаём.
    if (event.status === 'paid') {
      if (Number(event.amount_minor) !== Number(order.amount_minor)) {
        log.error('webhook.amount_mismatch', {
          event_id: eventId, order_id: order.id,
          expected_minor: order.amount_minor, got_minor: event.amount_minor,
        });
        return { outcome: await finish('amount_mismatch') };
      }
      if (String(event.currency).toUpperCase() !== String(order.currency).toUpperCase()) {
        log.error('webhook.currency_mismatch', {
          event_id: eventId, order_id: order.id, expected: order.currency, got: event.currency,
        });
        return { outcome: await finish('currency_mismatch') };
      }

      if (order.paid_at) {
        // Уже оплачен: повторное "оплачено" ничего не меняет, но выдачу подтолкнуть стоит.
        return { outcome: await finish('already_paid'), deliver: order.status !== 'delivered', orderId: order.id };
      }

      await client.query(
        `UPDATE orders SET status = 'paid', paid_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
        [order.id],
      );
      await recordPayment(client, order.id, order.amount_minor);
      log.info('payment.applied', { event_id: eventId, order_id: order.id, amount_minor: order.amount_minor });
      return { outcome: await finish('applied'), deliver: true, orderId: order.id };
    }

    // status === 'failed'
    if (order.paid_at) {
      // Успешная оплата уже была. Отказ по другой попытке её не отменяет,
      // независимо от того, в каком порядке события доехали.
      log.warn('webhook.failed_after_paid', { event_id: eventId, order_id: order.id, status: order.status });
      return { outcome: await finish('ignored_after_paid') };
    }

    await client.query(
      `UPDATE orders SET status = 'payment_failed', last_error = 'payment_failed', updated_at = now() WHERE id = $1`,
      [order.id],
    );
    log.info('payment.failed', { event_id: eventId, order_id: order.id });
    return { outcome: await finish('applied') };
  });
}

/**
 * Применить события, пришедшие раньше заказа.
 * Вызывается сразу после создания заказа и фоновым воркером.
 * Порядок разбора не влияет на итог, но идём по времени события для предсказуемых логов.
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
