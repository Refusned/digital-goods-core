import { Router } from 'express';
import { pool } from '../db.js';
import { reconciliationReport } from '../services/reconcile.js';
import { deliverOrder } from '../services/delivery.js';
import { getOrder, serializeOrder } from '../services/orders.js';

export const adminRouter = Router();

/** Отчёт сверки: оплачено-но-не-выдано, выдано-но-не-оплачено, зависшие вызовы, баланс журнала. */
adminRouter.get('/admin/reconciliation', async (req, res, next) => {
  try {
    res.json(await reconciliationReport({
      limit: Math.min(Number(req.query.limit) || 100, 500),
      overdueSeconds: req.query.overdue_seconds === undefined ? 60 : Math.max(Number(req.query.overdue_seconds) || 0, 0),
    }));
  } catch (err) {
    next(err);
  }
});

/** Ручная безопасная доводка заказа. Идемпотентна: на выданном заказе ничего не меняет. */
adminRouter.post('/admin/orders/:id/deliver', async (req, res, next) => {
  try {
    const result = await deliverOrder(req.params.id, { trigger: 'admin' });
    res.json({ result, order: serializeOrder(await getOrder(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/** Пополнение остатка на витрине (сам пул кодов живёт у поставщика). */
adminRouter.post('/admin/stock/:sku/restock', async (req, res, next) => {
  try {
    const count = Number(req.body?.count ?? 0);
    const { rows } = await pool.query(
      `INSERT INTO product_stock (sku, available) VALUES ($1, $2)
       ON CONFLICT (sku) DO UPDATE SET available = product_stock.available + EXCLUDED.available, updated_at = now()
       RETURNING sku, available`,
      [req.params.sku, count],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
