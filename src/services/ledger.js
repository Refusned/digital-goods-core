/**
 * Журнал денежных движений, двойная запись.
 * Каждая проводка пишется одним INSERT на две строки с общим txn_id и ON CONFLICT DO NOTHING,
 * поэтому повтор обработки не может задвоить деньги. Инвариант: sum(debit) = sum(credit).
 *
 * Счета:
 *   cash             деньги у нас
 *   deferred_revenue обязательство перед покупателем: оплачено, но ещё не выдано
 *   revenue          выручка, признанная фактом выдачи
 *   refunds_payable  обязательство вернуть деньги за невыданную позицию
 *
 * Отсюда следует главный инвариант второго этапа: по завершённому заказу
 * оплачено = выдано + возвращено, потому что deferred_revenue по нему обнуляется.
 */

const TXN = {
  payment: (orderId) => `pay:${orderId}`,
  delivery: (itemId) => `deliver:${itemId}`,
  refundAccrual: (itemId) => `refund_accrue:${itemId}`,
  refundSettlement: (itemId) => `refund_settle:${itemId}`,
};

async function post(client, txnId, orderId, amountMinor, debit, credit) {
  await client.query(
    `INSERT INTO ledger_entries (txn_id, order_id, account, direction, amount_minor)
     VALUES ($1, $2, $3, 'debit', $5), ($1, $2, $4, 'credit', $5)
     ON CONFLICT (txn_id, account, direction) DO NOTHING`,
    [txnId, orderId, debit, credit, amountMinor],
  );
}

/** Деньги пришли: касса выросла, выручка ещё не признана (товар не выдан). */
export const recordPayment = (client, orderId, amountMinor) =>
  post(client, TXN.payment(orderId), orderId, amountMinor, 'cash', 'deferred_revenue');

/** Позиция выдана: обязательство перед покупателем закрыто, выручка признана. */
export const recordDelivery = (client, orderId, itemId, amountMinor) =>
  post(client, TXN.delivery(itemId), orderId, amountMinor, 'deferred_revenue', 'revenue');

/**
 * Позицию выдать не удалось: обязательство "отдать товар" превращается в обязательство
 * "вернуть деньги". Признаётся сразу, ещё до фактической выплаты, иначе между решением
 * о возврате и выплатой деньги повисали бы в воздухе.
 */
export const recordRefundAccrual = (client, orderId, itemId, amountMinor) =>
  post(client, TXN.refundAccrual(itemId), orderId, amountMinor, 'deferred_revenue', 'refunds_payable');

/** Возврат ушёл покупателю: касса уменьшилась, обязательство закрыто. */
export const recordRefundSettlement = (client, orderId, itemId, amountMinor) =>
  post(client, TXN.refundSettlement(itemId), orderId, amountMinor, 'refunds_payable', 'cash');

/** Сводка по счетам плюс проверка, что журнал сходится. */
export async function ledgerBalance(client) {
  const { rows } = await client.query(
    `SELECT account,
            SUM(amount_minor) FILTER (WHERE direction = 'debit')  AS debit,
            SUM(amount_minor) FILTER (WHERE direction = 'credit') AS credit
       FROM ledger_entries
      GROUP BY account
      ORDER BY account`,
  );
  const accounts = rows.map((r) => ({
    account: r.account,
    debit_minor: Number(r.debit || 0),
    credit_minor: Number(r.credit || 0),
    balance_minor: Number(r.debit || 0) - Number(r.credit || 0),
  }));
  const totalDebit = accounts.reduce((s, a) => s + a.debit_minor, 0);
  const totalCredit = accounts.reduce((s, a) => s + a.credit_minor, 0);
  return { accounts, total_debit_minor: totalDebit, total_credit_minor: totalCredit, balanced: totalDebit === totalCredit };
}

/**
 * Денежная сверка по заказам: оплачено = выдано + возвращено + ещё в работе.
 * Считается из журнала, а не из статусов: статус можно проставить ошибочно, проводку нет.
 */
export async function moneyPerOrder(client, { onlyBroken = false, limit = 100 } = {}) {
  const { rows } = await client.query(
    `WITH per_order AS (
       SELECT order_id,
              COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'pay:%'            AND direction = 'debit'), 0)  AS paid_minor,
              COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'deliver:%'        AND direction = 'credit'), 0) AS delivered_minor,
              COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'refund_accrue:%'  AND direction = 'credit'), 0) AS refund_accrued_minor,
              COALESCE(SUM(amount_minor) FILTER (WHERE txn_id LIKE 'refund_settle:%'  AND direction = 'credit'), 0) AS refund_settled_minor
         FROM ledger_entries
        GROUP BY order_id
     )
     SELECT p.*, (p.paid_minor - p.delivered_minor - p.refund_accrued_minor) AS in_flight_minor
       FROM per_order p
      WHERE ($1 = FALSE OR (p.paid_minor - p.delivered_minor - p.refund_accrued_minor) < 0)
      ORDER BY p.order_id
      LIMIT $2`,
    [onlyBroken, limit],
  );
  return rows.map((r) => ({
    order_id: r.order_id,
    paid_minor: Number(r.paid_minor),
    delivered_minor: Number(r.delivered_minor),
    refund_accrued_minor: Number(r.refund_accrued_minor),
    refund_settled_minor: Number(r.refund_settled_minor),
    in_flight_minor: Number(r.in_flight_minor),
  }));
}
