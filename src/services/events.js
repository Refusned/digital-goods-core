/**
 * Журнал событий заказа.
 *
 * Единственный способ узнать, что было с заказом и с деньгами в прошлом: текущие строки
 * хранят только "сейчас". Журнал только дополняется, правку и удаление запрещает триггер в БД,
 * поэтому восстановление состояния на дату это чтение фактов, а не реконструкция по памяти.
 *
 * Событие пишется В ТОЙ ЖЕ транзакции, что и изменение состояния. Иначе после аварии
 * появилась бы история, расходящаяся с фактом.
 */

import { pool } from '../db.js';

/**
 * "Сейчас" для истории берётся из базы, а не из процесса.
 *
 * Часы приложения и базы расходятся (особенно когда база в контейнере), и отчёт "на сейчас",
 * построенный по часам процесса, может не увидеть только что записанные проводки.
 * Время истории должно измеряться там же, где история и живёт.
 */
export const dbNow = async () => (await pool.query('SELECT now() AS t')).rows[0].t;

export const EVENT = {
  orderCreated: 'order.created',
  orderPaid: 'order.paid',
  orderPaymentFailed: 'order.payment_failed',
  orderFinalized: 'order.finalized',
  itemQueued: 'item.queued',
  itemDelivering: 'item.delivering',
  itemDelivered: 'item.delivered',
  itemUnfulfillable: 'item.unfulfillable',
  itemRefundAccrued: 'item.refund_accrued',
  itemRefundSettled: 'item.refund_settled',
  supplierRejectedCode: 'supplier.code_rejected',
  supplierDiscrepancy: 'supplier.discrepancy',
};

/**
 * Записать событие. client обязателен там, где событие обязано быть атомарным с изменением;
 * для чисто наблюдательных записей допускается пул.
 */
export function recordEvent(client, { orderId, itemId = null, type, amountMinor = null, payload = {} }) {
  const runner = client || pool;
  return runner.query(
    `INSERT INTO order_events (order_id, order_item_id, type, amount_minor, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [orderId, itemId, type, amountMinor, JSON.stringify(payload)],
  );
}

/**
 * Состояние заказа на момент времени, свёрнутое ИЗ ЖУРНАЛА.
 * Намеренно не читает текущие строки orders/order_items: смысл ручки в том,
 * чтобы показать прошлое, а не пересказать настоящее.
 */
export async function orderStateAt(orderId, at) {
  const { rows } = await pool.query(
    `SELECT seq, order_item_id, type, amount_minor, payload, occurred_at
       FROM order_events
      WHERE order_id = $1 AND occurred_at <= $2
      ORDER BY seq`,
    [orderId, at.toISOString()],
  );
  if (rows.length === 0) return null;

  const state = {
    order_id: orderId,
    as_of: at.toISOString(),
    status: 'created',
    paid: false,
    amount_minor: 0,
    items: {},
    money: { paid_minor: 0, delivered_minor: 0, refund_accrued_minor: 0, refund_settled_minor: 0 },
    events: rows.length,
  };

  const item = (id) => (state.items[id] ||= { id, sku: null, amount_minor: 0, status: 'pending', code: null, supplier: null });

  for (const ev of rows) {
    const p = ev.payload || {};
    switch (ev.type) {
      case EVENT.orderCreated:
        state.amount_minor = Number(ev.amount_minor || 0);
        state.status = 'created';
        for (const it of p.items || []) {
          const rec = item(it.id);
          rec.sku = it.sku;
          rec.amount_minor = Number(it.amount_minor);
        }
        break;
      case EVENT.orderPaid:
        state.paid = true;
        state.status = 'paid';
        state.money.paid_minor = Number(ev.amount_minor || 0);
        break;
      case EVENT.orderPaymentFailed:
        state.status = 'payment_failed';
        break;
      case EVENT.itemDelivering:
        item(ev.order_item_id).status = 'delivering';
        break;
      case EVENT.itemDelivered: {
        const rec = item(ev.order_item_id);
        rec.status = 'delivered';
        rec.code = p.code ?? null;
        rec.supplier = p.supplier ?? null;
        state.money.delivered_minor += Number(ev.amount_minor || 0);
        break;
      }
      case EVENT.itemUnfulfillable:
        item(ev.order_item_id).status = 'unfulfillable';
        break;
      case EVENT.itemRefundAccrued:
        item(ev.order_item_id).status = 'refund_pending';
        state.money.refund_accrued_minor += Number(ev.amount_minor || 0);
        break;
      case EVENT.itemRefundSettled:
        item(ev.order_item_id).status = 'refunded';
        state.money.refund_settled_minor += Number(ev.amount_minor || 0);
        break;
      case EVENT.orderFinalized:
        state.status = p.status || state.status;
        break;
      default:
        break;
    }
  }

  state.items = Object.values(state.items);
  // Деньги, которые ещё не разошлись ни в выдачу, ни в возврат.
  state.money.in_flight_minor =
    state.money.paid_minor - state.money.delivered_minor - state.money.refund_accrued_minor;
  state.money.balanced = state.money.in_flight_minor >= 0;
  return state;
}

/** Баланс счетов на момент времени: журнал денег тоже только дополняется. */
export async function ledgerBalanceAt(at) {
  const { rows } = await pool.query(
    `SELECT account,
            COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0)  AS debit,
            COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0) AS credit
       FROM ledger_entries
      WHERE created_at <= $1
      GROUP BY account
      ORDER BY account`,
    [at.toISOString()],
  );
  const accounts = rows.map((r) => ({
    account: r.account,
    debit_minor: Number(r.debit),
    credit_minor: Number(r.credit),
    balance_minor: Number(r.debit) - Number(r.credit),
  }));
  const debit = accounts.reduce((s, a) => s + a.debit_minor, 0);
  const credit = accounts.reduce((s, a) => s + a.credit_minor, 0);
  return { as_of: at.toISOString(), accounts, total_debit_minor: debit, total_credit_minor: credit, balanced: debit === credit };
}

/**
 * Итоги за период, посчитанные из журнала событий, и сверка их с журналом денег.
 * Две независимые записи одного и того же факта должны сойтись; если нет, отчёт это покажет.
 */
export async function periodReport(from, to) {
  const events = await pool.query(
    `SELECT type,
            count(*)::int AS count,
            COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM order_events
      WHERE occurred_at > $1 AND occurred_at <= $2
      GROUP BY type
      ORDER BY type`,
    [from.toISOString(), to.toISOString()],
  );

  const byType = Object.fromEntries(events.rows.map((r) => [r.type, { count: r.count, amount_minor: Number(r.amount_minor) }]));
  const get = (t) => byType[t] || { count: 0, amount_minor: 0 };

  const ledger = await pool.query(
    `SELECT account, direction, COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM ledger_entries
      WHERE created_at > $1 AND created_at <= $2
      GROUP BY account, direction`,
    [from.toISOString(), to.toISOString()],
  );
  const led = (account, direction) =>
    Number(ledger.rows.find((r) => r.account === account && r.direction === direction)?.amount_minor || 0);

  const paid = get('order.paid');
  const delivered = get('item.delivered');
  const refunded = get('item.refund_settled');

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    orders_paid: { count: paid.count, amount_minor: paid.amount_minor },
    items_delivered: { count: delivered.count, amount_minor: delivered.amount_minor },
    refunds_settled: { count: refunded.count, amount_minor: refunded.amount_minor },
    by_event_type: byType,
    // Сверка: то же самое, но по журналу денег. Расхождения должны быть нулевыми.
    cross_check: {
      cash_in_minor: led('cash', 'debit'),
      cash_out_minor: led('cash', 'credit'),
      revenue_minor: led('revenue', 'credit'),
      paid_diff_minor: paid.amount_minor - led('cash', 'debit'),
      delivered_diff_minor: delivered.amount_minor - led('revenue', 'credit'),
      refund_diff_minor: refunded.amount_minor - led('cash', 'credit'),
      matches:
        paid.amount_minor === led('cash', 'debit') &&
        delivered.amount_minor === led('revenue', 'credit') &&
        refunded.amount_minor === led('cash', 'credit'),
    },
  };
}
