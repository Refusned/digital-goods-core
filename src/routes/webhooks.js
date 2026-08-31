import { Router } from 'express';
import { handlePaymentWebhook } from '../services/payments.js';
import { deliverOrder } from '../services/delivery.js';

export const webhooksRouter = Router();

/**
 * Эндпоинт платёжной системы.
 * Отвечает сразу после фиксации события: выдача идёт вне запроса, платёжка не должна её ждать.
 * Любая внутренняя ошибка -> 5xx, чтобы платёжка повторила доставку.
 */
webhooksRouter.post('/webhook/payment', async (req, res, next) => {
  try {
    const result = await handlePaymentWebhook(req.body);
    res.status(200).json({ received: true, outcome: result.outcome });

    if (result.deliver && result.orderId) {
      deliverOrder(result.orderId, { trigger: 'webhook' }).catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});
