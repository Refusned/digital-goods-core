import { randomUUID } from 'node:crypto';

const short = () => randomUUID().replace(/-/g, '').slice(0, 12);

export const newOrderId = () => `ord_${short()}`;
export const newEventId = () => `evt_${short()}`;

/**
 * request_id для поставщика ДЕТЕРМИНИРОВАН по паре (заказ, поставщик).
 * Это и есть защита от ловушки таймаута: любой повтор уходит с тем же request_id,
 * поставщик по контракту обязан вернуть тот же код, а не выдать новый.
 */
export const supplierRequestId = (orderId, supplier) => `req_${orderId}_${supplier}`;
