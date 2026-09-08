import { Router } from 'express';
import { createOrder, getOrder, serializeOrder, ApiError } from '../services/orders.js';
import { applyPendingEvents } from '../services/payments.js';
import { deliverOrder } from '../services/delivery.js';
import { dbNow, orderStateAt } from '../services/events.js';

export const ordersRouter = Router();

/**
 * Создание заказа.
 * Первый этап: { sku }. Второй: { items: [{ sku, qty }] }. Оба контракта живые.
 * reserve: true разрешает начать выдачу до оплаты, но с низким приоритетом.
 */
ordersRouter.post('/orders', async (req, res, next) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key || null;
    const { order, reused } = await createOrder({
      sku: req.body?.sku,
      items: req.body?.items,
      idempotencyKey,
      buyerContact: req.body?.buyer_contact ?? null,
      orderId: req.body?.order_id ?? null,
      reserve: req.body?.reserve === true,
    });

    // Вебхук мог прийти раньше заказа, применяем накопленные события сразу.
    //
    // Резерв до оплаты намеренно НЕ выдаётся здесь: он встаёт в общую очередь с низким
    // приоритетом, иначе неоплаченный заказ обходил бы оплаченные по прямому пути.
    const applied = await applyPendingEvents(order.id);
    if (applied.some((r) => r.deliver)) {
      deliverOrder(order.id, { trigger: 'order.created' }).catch(() => {});
    }

    const fresh = await getOrder(order.id);
    res.status(reused ? 200 : 201).json(serializeOrder(fresh));
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/orders/:id', async (req, res, next) => {
  try {
    res.json(serializeOrder(await getOrder(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Состояние заказа на произвольный момент прошлого.
 * Собирается из журнала событий, а не из текущих строк: смысл ручки в том,
 * чтобы показать, как было, а не пересказать, как есть.
 */
ordersRouter.get('/orders/:id/at', async (req, res, next) => {
  try {
    const raw = req.query.ts || req.query.at;
    const at = raw ? new Date(String(raw)) : await dbNow();
    if (Number.isNaN(at.getTime())) throw new ApiError(400, 'bad_request', 'ts: дата в ISO 8601');

    const state = await orderStateAt(req.params.id, at);
    if (!state) return res.status(404).json({ error: 'no_history', message: `На ${at.toISOString()} заказа ${req.params.id} ещё не существовало` });
    res.json(state);
  } catch (err) {
    next(err);
  }
});
