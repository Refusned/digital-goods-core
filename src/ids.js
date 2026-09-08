import { randomUUID } from 'node:crypto';

const short = () => randomUUID().replace(/-/g, '').slice(0, 12);

export const newOrderId = () => `ord_${short()}`;
export const newEventId = () => `evt_${short()}`;

/** Идентификатор позиции детерминирован: повтор создания заказа не плодит новые позиции. */
export const orderItemId = (orderId, position) => `itm_${orderId}_${position}`;

/**
 * request_id для поставщика ДЕТЕРМИНИРОВАН по тройке (позиция, поставщик, эпоха).
 * Это защита от ловушки таймаута: повтор внутри эпохи уходит с тем же request_id,
 * и поставщик по контракту обязан вернуть тот же код, а не выдать новый.
 *
 * Эпоха растёт только когда поставщик прислал НЕГОДНЫЙ код (дубль или чужой):
 * тогда нам нужен именно другой код, и мы осознанно делаем другой запрос.
 */
export const supplierRequestId = (itemId, supplier, epoch = 0) =>
  (epoch === 0 ? `req_${itemId}_${supplier}` : `req_${itemId}_${supplier}_e${epoch}`);

/** Идентификатор возврата детерминирован по позиции: повторная выплата невозможна. */
export const refundId = (itemId) => `rfnd_${itemId}`;
