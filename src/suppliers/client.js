import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Сетевые ошибки, при которых запрос ТОЧНО не дошёл до поставщика: соединение не установилось.
 * Только они дают право считать, что кода нет, и уходить на резервного поставщика.
 * Всё остальное (в том числе обрыв уже установленного сокета) трактуется как неизвестный исход.
 */
const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL']);

/**
 * HTTP-клиент поставщика с жёстким разделением трёх исходов:
 *
 *   ok      это код получен;
 *   failed  это поставщик ТОЧНО не выдал код: пришёл явный ответ с отказом,
 *           либо соединение вообще не установилось. Только здесь разрешён резервный поставщик;
 *   unknown это неопределённость: таймаут или обрыв уже установленного соединения.
 *           Ответа нет, но запрос мог дойти и код мог быть выдан. Уходить на другого поставщика нельзя,
 *           можно только повторить к этому же с тем же request_id.
 *
 * Принцип fail closed: любая неоднозначность считается unknown, а не отказом.
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
    // 5xx считаем временным и повторяем к нему же, 4xx это контрактный отказ.
    const retryable = res.status >= 500;
    log.warn('supplier.call.failed', {
      supplier: supplier.name, request_id: requestId, order_id: orderId,
      http_status: res.status, reason: body.reason, retryable, took_ms: took,
    });
    return { outcome: 'failed', reason: body.reason || `http_${res.status}`, retryable };
  } catch (err) {
    const took = Date.now() - started;
    const cause = err.cause?.code || err.code || err.name;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';

    // Некорректный адрес поставщика: запрос физически не отправлялся.
    const badTarget = !timedOut && !err.cause?.code && /bad port|Invalid URL|Failed to parse URL/i.test(err.cause?.message || err.message || '');

    if (!timedOut && (CONNECT_FAILURES.has(cause) || badTarget)) {
      // Соединения не было: байты не ушли, код выдан быть не мог.
      const why = badTarget ? 'bad_target' : cause;
      log.warn('supplier.call.unreachable', { supplier: supplier.name, request_id: requestId, order_id: orderId, cause: why, took_ms: took });
      return { outcome: 'failed', reason: `unreachable:${why}`, retryable: false };
    }

    // Таймаут или обрыв уже установленного соединения: исход неизвестен.
    log.warn('supplier.call.unknown', {
      supplier: supplier.name, request_id: requestId, order_id: orderId,
      cause: timedOut ? 'timeout' : cause, took_ms: took,
    });
    return { outcome: 'unknown', reason: timedOut ? 'timeout' : `socket:${cause}` };
  }
}

/** Остатки поставщика по товарам. Нужны, чтобы витрина показывала реальную доступность, а не выдумку. */
export async function fetchStock(supplier, sku = null, { timeoutMs = config.supplierTimeoutMs } = {}) {
  try {
    const url = new URL('/stock', supplier.baseUrl);
    if (sku) url.searchParams.set('sku', sku);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.items) ? body.items : [];
  } catch (err) {
    log.warn('supplier.stock_unavailable', { supplier: supplier.name, error: err.cause?.code || err.name });
    return null;
  }
}
