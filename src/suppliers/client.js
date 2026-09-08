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

    // Ответ получен, но кода в нём нет.
    //
    // Во втором этапе ответу об ошибке верить НЕЛЬЗЯ: поставщик мог выдать код и всё равно
    // ответить 500. Поэтому явный отказ больше не считается доказательством того, что кода нет,
    // это делает отдельная проверка через /issued (см. confirmIssued).
    // 429 стоит особняком: лимит превышен, запрос точно не обработан, повторять можно позже.
    const rateLimited = res.status === 429;
    const retryable = res.status >= 500 || rateLimited;
    log.warn('supplier.call.failed', {
      supplier: supplier.name, request_id: requestId, order_id: orderId,
      http_status: res.status, reason: body.reason, retryable, took_ms: took,
    });
    return {
      outcome: 'failed',
      reason: body.reason || `http_${res.status}`,
      retryable,
      rateLimited,
      retryAfterMs: Number(body.retry_after_ms) || null,
      httpStatus: res.status,
    };
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
      // proven: отказ ДОКАЗАН самим фактом отсутствия соединения, переспрашивать нечего и некого.
      return { outcome: 'failed', reason: `unreachable:${why}`, retryable: false, proven: true };
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

/**
 * Что поставщик считает выданным по конкретному запросу.
 *
 * Ключевой инструмент второго этапа: ответу об ошибке доверять нельзя, поэтому прежде
 * чем признать отказ и уйти к резервному поставщику, мы спрашиваем у него самого,
 * не выдал ли он всё-таки код. Если выдал, забираем этот код, а не просим второй.
 *
 * null означает "спросить не удалось", и это НЕ то же самое, что "не выдавал".
 */
export async function confirmIssued(supplier, requestId, { timeoutMs = config.supplierTimeoutMs } = {}) {
  try {
    const res = await fetch(`${supplier.baseUrl}/issued/${encodeURIComponent(requestId)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.status === 'issued' && body.code) return { issued: true, code: body.code, sku: body.sku ?? null };
    if (body.status === 'none' || body.status === 'released') return { issued: false };
    return null;
  } catch (err) {
    log.warn('supplier.confirm_unavailable', { supplier: supplier.name, request_id: requestId, error: err.cause?.code || err.name });
    return null;
  }
}

/**
 * Проверка принадлежности кода товару.
 * Поставщик может прислать код от другого товара, и заметить это может только тот,
 * кто спросит про сам код, а не про запрос.
 */
export async function verifyCode(supplier, code, { timeoutMs = config.supplierTimeoutMs } = {}) {
  try {
    const url = new URL('/verify', supplier.baseUrl);
    url.searchParams.set('code', code);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    // Поставщик вообще не умеет проверку принадлежности кода. Это не сбой, а свойство
    // интеграции: держать из-за него оплаченный заказ бессмысленно, повтор ничего не изменит.
    if (res.status === 404 || res.status === 501 || res.status === 405) {
      return { status: 'unsupported', supported: false };
    }
    if (!res.ok) return null;
    return { ...(await res.json()), supported: true };
  } catch (err) {
    // Сетевая беда: проверка временно недоступна, и это повод подождать, а не поверить на слово.
    log.warn('supplier.verify_unavailable', { supplier: supplier.name, error: err.cause?.code || err.name });
    return null;
  }
}

/** Вернуть поставщику код, который мы отбраковали: иначе товар исчезает со склада навсегда. */
export async function releaseCode(supplier, requestId, { timeoutMs = config.supplierTimeoutMs } = {}) {
  try {
    const res = await fetch(`${supplier.baseUrl}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log.warn('supplier.release_unavailable', { supplier: supplier.name, request_id: requestId, error: err.cause?.code || err.name });
    return null;
  }
}

/** Журнал выдач поставщика с курсором: по нему идёт фоновая сверка. */
export async function fetchJournal(supplier, after = 0, { limit = 200, timeoutMs = config.supplierTimeoutMs } = {}) {
  try {
    const url = new URL('/journal', supplier.baseUrl);
    url.searchParams.set('after', String(after));
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log.warn('supplier.journal_unavailable', { supplier: supplier.name, error: err.cause?.code || err.name });
    return null;
  }
}
