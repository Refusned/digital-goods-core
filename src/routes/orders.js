import { Router } from 'express';
import { createOrder, getOrder, serializeOrder } from '../services/orders.js';
import { applyPendingEvents } from '../services/payments.js';
import { deliverOrder } from '../services/delivery.js';

export const ordersRouter = Router();

ordersRouter.post('/orders', async (req, res, next) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key || null;
    const { order, reused } = await createOrder({
      sku: req.body?.sku,
      idempotencyKey,
      buyerContact: req.body?.buyer_contact ?? null,
      orderId: req.body?.order_id ?? null,
    });

    // Вебхук мог прийти раньше заказа, применяем накопленные события сразу.
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
