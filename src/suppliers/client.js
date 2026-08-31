import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * HTTP-клиент поставщика с жёстким разделением трёх исходов:
 *
 *   ok      это код получен;
 *   failed  это поставщик ТОЧНО не выдал код (соединение не установилось, либо пришёл явный отказ).
 *             Только в этом случае разрешён уход на резервного поставщика;
 *   unknown это таймаут. Ответа нет, но запрос мог дойти и код мог быть выдан.
 *             Уходить на другого поставщика нельзя, можно только повторить с тем же request_id.
 */
export async function issue(supplier, { requestId, sku, orderId }, { timeoutMs = config.supplierTimeoutMs } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(`${supplier.baseUrl}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, sku, order_id: orderId }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await res.json().catch(() => ({}));
    const took = Date.now() - started;

    if (res.ok && body.status === 'ok' && body.code) {
      log.info('supplier.call.ok', { supplier: supplier.name, request_id: requestId, order_id: orderId, took_ms: took });
      return { outcome: 'ok', code: body.code };
    }

    // Ответ получен, значит поставщик решение принял и кода не дал.
    log.warn('supplier.call.failed', {
      supplier: supplier.name, request_id: requestId, order_id: orderId,
      http_status: res.status, reason: body.reason, took_ms: took,
    });
    return { outcome: 'failed', reason: body.reason || `http_${res.status}` };
  } catch (err) {
    const took = Date.now() - started;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';

    if (timedOut) {
      log.warn('supplier.call.timeout', { supplier: supplier.name, request_id: requestId, order_id: orderId, took_ms: took });
      return { outcome: 'unknown', reason: 'timeout' };
    }

    // Соединение не установлено: до поставщика запрос не дошёл, код выдан быть не мог.
    const cause = err.cause?.code || err.code || err.message;
    log.warn('supplier.call.unreachable', { supplier: supplier.name, request_id: requestId, order_id: orderId, cause, took_ms: took });
    return { outcome: 'failed', reason: `unreachable:${cause}` };
  }
}
