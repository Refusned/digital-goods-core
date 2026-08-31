/**
 * Журнал денежных движений, двойная запись.
 * Каждая проводка пишется одним INSERT на две строки с общим txn_id и ON CONFLICT DO NOTHING,
 * поэтому повтор обработки не может задвоить деньги. Инвариант: sum(debit) = sum(credit).
 */

const TXN = {
  payment: (orderId) => `pay:${orderId}`,
  delivery: (orderId) => `deliver:${orderId}`,
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

/** Товар выдан: обязательство перед покупателем закрыто, выручка признана. */
export const recordDelivery = (client, orderId, amountMinor) =>
  post(client, TXN.delivery(orderId), orderId, amountMinor, 'deferred_revenue', 'revenue');

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
