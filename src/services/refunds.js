/**
 * Возвраты за невыданные позиции.
 *
 * Правило заказа из нескольких товаров: что смогли выдать, остаётся у покупателя,
 * за что не смогли, деньги возвращаются. Отсюда два требования:
 *
 *   1. решение о возврате должно приниматься само, без человека, и в конечное время
 *      (иначе "ждём код" превращается в "деньги зависли навсегда");
 *   2. возврат должен быть идемпотентным на всех этапах: и начисление, и выплата.
 *
 * Идемпотентность держится идентификаторами, а не аккуратностью кода:
 * refunds.order_item_id UNIQUE, refund_id детерминирован по позиции, проводки уникальны по txn_id.
 */

import { pool, withTx } from '../db.js';
import { config } from '../config.js';
import { refundId as makeRefundId } from '../ids.js';
import { log } from '../logger.js';
import { recordRefundAccrual, recordRefundSettlement } from './ledger.js';
import { EVENT, recordEvent } from './events.js';
import { refreshOrderStatus } from './orders.js';

/**
 * Позиция признаётся невыдаваемой, за неё начисляется возврат.
 * Начисление и смена статуса идут одной транзакцией: деньги не должны зависать
 * между "выдать не смогли" и "вернуть решили".
 */
export async function markUnfulfillable(itemId, reason) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT i.*, o.paid_at, o.currency AS order_currency
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [itemId],
    );
    if (rows.length === 0) return { outcome: 'item_not_found' };
    const item = rows[0];

    if (item.status === 'delivered') return { outcome: 'already_delivered' };
    if (['unfulfillable', 'refunded'].includes(item.status)) return { outcome: 'already_marked' };

    await client.query(
      `UPDATE order_items SET status = 'unfulfillable', last_error = $2, next_attempt_at = NULL, updated_at = now()
        WHERE id = $1`,
      [itemId, reason],
    );
    await recordEvent(client, {
      orderId: item.order_id, itemId, type: EVENT.itemUnfulfillable,
      amountMinor: Number(item.amount_minor), payload: { reason, sku: item.sku },
    });

    // Деньги возвращаются только если они приходили. Неоплаченный заказ просто закрывается.
    if (!item.paid_at) {
      log.info('item.unfulfillable_unpaid', { item_id: itemId, reason });
      return { outcome: 'unfulfillable_unpaid' };
    }

    const id = makeRefundId(itemId);
    await client.query(
      `INSERT INTO refunds (id, order_id, order_item_id, amount_minor, currency, reason, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
       ON CONFLICT (order_item_id) DO NOTHING`,
      [id, item.order_id, itemId, Number(item.amount_minor), item.currency, reason],
    );
    await recordRefundAccrual(client, item.order_id, itemId, Number(item.amount_minor));
    await recordEvent(client, {
      orderId: item.order_id, itemId, type: EVENT.itemRefundAccrued,
      amountMinor: Number(item.amount_minor), payload: { reason, refund_id: id },
    });

    log.warn('refund.accrued', { order_id: item.order_id, item_id: itemId, amount_minor: Number(item.amount_minor), reason });
    return { outcome: 'refund_accrued', refund_id: id, amount_minor: Number(item.amount_minor) };
  });
}

/**
 * Выплата одного возврата через платёжный шлюз.
 *
 * refund_id детерминирован по позиции, поэтому повтор после таймаута не выплатит деньги дважды:
 * шлюз обязан вернуть тот же provider_ref. Ответ шлюза при этом не является доказательством
 * того, что выплаты не было: при неопределённости мы просто повторяем с тем же идентификатором.
 */
export async function settleRefund(refundIdValue) {
  const { rows } = await pool.query('SELECT * FROM refunds WHERE id = $1', [refundIdValue]);
  if (rows.length === 0) return { outcome: 'refund_not_found' };
  const refund = rows[0];
  if (refund.status === 'settled') return { outcome: 'already_settled' };

  let response = null;
  try {
    const res = await fetch(`${config.payments.baseUrl}/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        refund_id: refund.id,
        order_id: refund.order_id,
        amount: Number(refund.amount_minor),
        currency: refund.currency,
      }),
      signal: AbortSignal.timeout(config.payments.timeoutMs),
    });
    if (res.ok) response = await res.json();
  } catch (err) {
    log.warn('refund.gateway_unavailable', { refund_id: refund.id, error: err.cause?.code || err.name });
  }

  if (!response || response.status !== 'ok') {
    await pool.query(
      `UPDATE refunds
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
              next_attempt_at = now() + ($4 || ' milliseconds')::interval
        WHERE id = $1`,
      [refund.id, 'gateway_unavailable', config.refunds.maxAttempts, String(config.refunds.retryMs)],
    );
    return { outcome: 'retry_later' };
  }

  return withTx(async (client) => {
    const fresh = await client.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refund.id]);
    if (fresh.rows[0].status === 'settled') return { outcome: 'already_settled' };

    await client.query(
      `UPDATE refunds SET status = 'settled', settled_at = now(), provider_ref = $2, last_error = NULL, next_attempt_at = NULL
        WHERE id = $1`,
      [refund.id, response.provider_ref ?? null],
    );
    await client.query(
      `UPDATE order_items SET status = 'refunded', updated_at = now() WHERE id = $1`,
      [refund.order_item_id],
    );
    await recordRefundSettlement(client, refund.order_id, refund.order_item_id, Number(refund.amount_minor));
    await recordEvent(client, {
      orderId: refund.order_id, itemId: refund.order_item_id, type: EVENT.itemRefundSettled,
      amountMinor: Number(refund.amount_minor),
      payload: { refund_id: refund.id, provider_ref: response.provider_ref ?? null },
    });
    await refreshOrderStatus(refund.order_id, client);

    log.info('refund.settled', { order_id: refund.order_id, refund_id: refund.id, amount_minor: Number(refund.amount_minor) });
    return { outcome: 'settled', provider_ref: response.provider_ref ?? null };
  });
}

/**
 * Позиции, которые пора признать невыдаваемыми: исчерпаны попытки или вышел срок.
 * Срок отсчитывается от оплаты и существует именно для того, чтобы заказ гарантированно
 * доходил до конечного состояния, а не висел в ожидании кода бесконечно.
 *
 * "Нет остатка" счётчик попыток не исчерпывает: это не отказ системы, а ожидание завоза,
 * и его ограничивает только срок. Иначе товар, который завезут через минуту,
 * возвращался бы покупателю деньгами через десять секунд.
 */
export async function sweepUnfulfillable({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT i.id, i.attempts, i.deadline_at, i.last_error
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE i.status IN ('pending', 'delivering')
        AND o.paid_at IS NOT NULL
        AND (
              (i.deadline_at IS NOT NULL AND i.deadline_at <= now())
              OR (i.attempts >= $1 AND COALESCE(i.last_error, '') NOT LIKE '%out_of_stock%')
            )
      ORDER BY i.updated_at
      LIMIT $2`,
    [config.delivery.maxItemAttempts, limit],
  );

  const results = [];
  for (const row of rows) {
    const reason = row.deadline_at && new Date(row.deadline_at) <= new Date()
      ? `deadline_exceeded:${row.last_error || 'no_code'}`
      : `attempts_exhausted:${row.last_error || 'no_code'}`;
    results.push(await markUnfulfillable(row.id, reason));
  }
  return results;
}

/** Выплатить накопившиеся возвраты. */
export async function processRefunds({ limit = 25 } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM refunds
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT $1`,
    [limit],
  );
  const results = [];
  for (const row of rows) results.push(await settleRefund(row.id));
  return results;
}
