import { Router } from 'express';
import { config } from '../config.js';
import { reconciliationReport } from '../services/reconcile.js';
import { deliverOrder, syncStock } from '../services/delivery.js';
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

/**
 * Завоз товара. Ключи живут у поставщика, поэтому ручка завозит их ЕМУ,
 * а витрина после этого пересчитывается по факту. Рисовать остаток на витрине нельзя:
 * иначе каталог обещает то, чего на складах нет.
 */
adminRouter.post('/admin/stock/:sku/restock', async (req, res, next) => {
  try {
    const sku = req.params.sku;
    const supplierName = String(req.body?.supplier ?? 'A').toUpperCase();
    const supplier = supplierName === 'B' ? config.suppliers.b : config.suppliers.a;

    const codes = Array.isArray(req.body?.codes) && req.body.codes.length
      ? req.body.codes
      : Array.from({ length: Number(req.body?.count ?? 1) }, () =>
          `RESTOCK-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);

    const restocked = await fetch(`${supplier.baseUrl}/_restock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku, codes }),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));

    if (restocked.error) return res.status(502).json({ error: 'supplier_unavailable', detail: restocked.error });

    const available = await syncStock(sku);
    res.json({ sku, supplier: supplier.name, added: restocked.added, available });
  } catch (err) {
    next(err);
  }
});
