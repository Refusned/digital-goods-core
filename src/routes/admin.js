import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { reconciliationReport } from '../services/reconcile.js';
import { deliverOrder, deliverItem, syncStock } from '../services/delivery.js';
import { getOrder, serializeOrder, ApiError } from '../services/orders.js';
import { dbNow, ledgerBalanceAt, periodReport } from '../services/events.js';
import { discrepancyReport, reconcileSuppliers } from '../services/supplier-audit.js';
import { inspect as inspectRateLimit, setLimit } from '../services/ratelimit.js';
import { processRefunds, sweepUnfulfillable } from '../services/refunds.js';

export const adminRouter = Router();

/** Отчёт сверки: оплачено-но-не-выдано, выдано-но-не-оплачено, возвраты, баланс журнала. */
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

/**
 * Прогресс очереди под всплеском: сколько ждёт, сколько в работе, сколько уже выдано,
 * и сколько разрешений осталось у каждого поставщика.
 */
adminRouter.get('/admin/queue', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE i.status = 'pending')::int       AS queued,
         count(*) FILTER (WHERE i.status = 'delivering')::int    AS in_flight,
         count(*) FILTER (WHERE i.status = 'delivered')::int     AS delivered,
         count(*) FILTER (WHERE i.status = 'unfulfillable')::int AS unfulfillable,
         count(*) FILTER (WHERE i.status = 'refunded')::int      AS refunded,
         count(*) FILTER (WHERE i.status IN ('pending', 'delivering') AND i.priority = $1)::int AS waiting_paid,
         count(*) FILTER (WHERE i.status IN ('pending', 'delivering') AND i.priority > $1)::int AS waiting_unpaid,
         COALESCE(EXTRACT(EPOCH FROM (now() - MIN(i.queued_at) FILTER (WHERE i.status IN ('pending', 'delivering')))) * 1000, 0)::bigint AS oldest_wait_ms
       FROM order_items i`,
      [config.priority.paid],
    );

    const throughput = await pool.query(
      `SELECT count(*)::int AS delivered_last_min
         FROM order_events
        WHERE type = 'item.delivered' AND occurred_at > now() - interval '1 minute'`,
    );

    const limits = [];
    for (const supplier of [config.suppliers.a, config.suppliers.b]) {
      limits.push(await inspectRateLimit(supplier.name));
    }

    res.json({
      ...rows[0],
      oldest_wait_ms: Number(rows[0].oldest_wait_ms),
      delivered_last_min: throughput.rows[0].delivered_last_min,
      rate_limits: limits,
    });
  } catch (err) {
    next(err);
  }
});

/** Настройка лимита поставщика: он приходит из договора и должен меняться без перезапуска. */
adminRouter.post('/admin/suppliers/:name/rate-limit', async (req, res, next) => {
  try {
    const capacity = Number(req.body?.capacity);
    const windowMs = Number(req.body?.window_ms ?? 60_000);
    if (!Number.isInteger(capacity) || capacity < 1) throw new ApiError(400, 'bad_request', 'capacity: целое от 1');
    if (!Number.isInteger(windowMs) || windowMs < 100) throw new ApiError(400, 'bad_request', 'window_ms: целое от 100');
    await setLimit(String(req.params.name).toUpperCase(), { capacity, windowMs });
    res.json(await inspectRateLimit(String(req.params.name).toUpperCase()));
  } catch (err) {
    next(err);
  }
});

/** Расхождения с поставщиками: что нашли и как разобрали. */
adminRouter.get('/admin/discrepancies', async (req, res, next) => {
  try {
    res.json(await discrepancyReport({ limit: Math.min(Number(req.query.limit) || 100, 500) }));
  } catch (err) {
    next(err);
  }
});

/** Ручной прогон сверки с поставщиками. Фоновая делает то же самое по расписанию. */
adminRouter.post('/admin/audit/run', async (_req, res, next) => {
  try {
    res.json(await reconcileSuppliers());
  } catch (err) {
    next(err);
  }
});

/** Ручной прогон разбора невыдаваемых позиций и выплаты возвратов. */
adminRouter.post('/admin/refunds/run', async (_req, res, next) => {
  try {
    const swept = await sweepUnfulfillable();
    const settled = await processRefunds();
    res.json({ swept, settled });
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

/** То же самое для одной позиции. */
adminRouter.post('/admin/items/:id/deliver', async (req, res, next) => {
  try {
    res.json(await deliverItem(req.params.id, { trigger: 'admin' }));
  } catch (err) {
    next(err);
  }
});

/** Баланс счетов на произвольный момент прошлого. */
adminRouter.get('/admin/ledger/at', async (req, res, next) => {
  try {
    const raw = req.query.ts || req.query.at;
    const at = raw ? new Date(String(raw)) : await dbNow();
    if (Number.isNaN(at.getTime())) throw new ApiError(400, 'bad_request', 'ts: дата в ISO 8601');
    res.json(await ledgerBalanceAt(at));
  } catch (err) {
    next(err);
  }
});

/** Итоги за период, посчитанные из журнала событий и сверенные с журналом денег. */
adminRouter.get('/admin/report', async (req, res, next) => {
  try {
    const to = req.query.to ? new Date(String(req.query.to)) : await dbNow();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ApiError(400, 'bad_request', 'from и to: даты в ISO 8601');
    }
    res.json(await periodReport(from, to));
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

    // Явно переданный список кодов используется как есть, в том числе пустой:
    // "завези вот эти коды" и "ничего не завози, только пересчитай витрину" это разные команды,
    // и вторая не должна молча превращаться в завоз случайного ключа.
    const codes = Array.isArray(req.body?.codes)
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
