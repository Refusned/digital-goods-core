/**
 * Лимит запросов к поставщику.
 *
 * Лимит известен нам заранее по договору, поэтому задача не "красиво обработать 429",
 * а вообще не отправить лишний запрос.
 *
 * Считаем ровно тем же способом, каким считает поставщик: скользящее окно по журналу
 * выданных разрешений. Приблизительное ведро токенов здесь не годится: после простоя
 * оно позволяет мгновенно потратить накопленный запас и тут же добрать пополнение,
 * то есть отправить в одно окно заметно больше договорного лимита.
 *
 * Журнал живёт в БД, а не в памяти процесса: иначе два экземпляра сервиса каждый выдержал бы
 * свой лимит, а поставщик получил бы двойной. Захват идёт под блокировкой на время транзакции,
 * поэтому параллельные диспетчеры не могут выдать больше разрешений, чем есть.
 *
 * Единственное расхождение с поставщиком: мы отмечаем момент выдачи разрешения, а он момент
 * приёма запроса, и время в пути у разных запросов разное. На границе окна это способно
 * сдвинуть один запрос внутрь чужого окна, поэтому своё окно мы считаем шире договорного
 * на SAFETY_MARGIN. Цена этого запаса небольшая: мы просто чуть недоиспользуем лимит.
 */

import { pool, withTx } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';

// Насколько шире договорного мы считаем собственное окно, закрывая разброс времени в пути.
const SAFETY_MARGIN = 0.15;

/** Ведро создаётся при первом обращении: конфигурация поставщика может появиться на ходу. */
export async function ensureBucket(supplier, {
  capacity = config.rateLimit.capacity,
  windowMs = config.rateLimit.windowMs,
} = {}) {
  await pool.query(
    `INSERT INTO supplier_rate_limits (supplier, capacity, window_ms)
     VALUES ($1, $2::int, $3::int)
     ON CONFLICT (supplier) DO NOTHING`,
    [supplier, capacity, windowMs],
  );
}

/** Поменять лимит на ходу: нужно и в тестах, и когда поставщик меняет условия. */
export async function setLimit(supplier, { capacity, windowMs }) {
  await ensureBucket(supplier, { capacity, windowMs });
  await pool.query(
    `UPDATE supplier_rate_limits
        SET capacity = $2::int, window_ms = $3::int, updated_at = now()
      WHERE supplier = $1`,
    [supplier, capacity, windowMs],
  );
  log.info('ratelimit.configured', { supplier, capacity, window_ms: windowMs });
}

/**
 * Попробовать взять n разрешений. Возвращает, сколько выдано (0..n).
 *
 * Частичная выдача это норма: диспетчер отправит столько запросов, сколько поместилось в лимит,
 * а остальные позиции останутся в очереди и уйдут на следующем проходе.
 */
export async function acquire(supplier, n = 1) {
  if (!config.rateLimit.enabled) return n;
  if (n <= 0) return 0;
  await ensureBucket(supplier);

  return withTx(async (client) => {
    // Блокировка на время транзакции сериализует захваты по этому поставщику.
    //
    // Одним запросом с общими подзапросами это не решается: подзапросы одного оператора
    // работают с общим снимком данных, поэтому параллельные захваты посчитали бы одно и то же
    // число уже выданных разрешений и вместе превысили бы лимит. Внутри транзакции каждый
    // следующий оператор берёт свежий снимок, поэтому счёт после блокировки честный.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`ratelimit:${supplier}`]);

    const bucket = await client.query(
      'SELECT capacity, window_ms FROM supplier_rate_limits WHERE supplier = $1', [supplier]);
    if (bucket.rowCount === 0) return 0;
    const { capacity, window_ms: windowMs } = bucket.rows[0];

    const used = await client.query(
      `SELECT count(*)::int AS taken FROM supplier_rate_events
        WHERE supplier = $1 AND granted_at > now() - ($2 || ' milliseconds')::interval`,
      [supplier, String(Math.round(windowMs * (1 + SAFETY_MARGIN)))],
    );
    const take = Math.max(0, Math.min(n, capacity - used.rows[0].taken));
    if (take === 0) return 0;

    await client.query(
      `INSERT INTO supplier_rate_events (supplier) SELECT $1 FROM generate_series(1, $2)`,
      [supplier, take],
    );
    await client.query(
      'UPDATE supplier_rate_limits SET granted = granted + $2, updated_at = now() WHERE supplier = $1',
      [supplier, take],
    );
    return take;
  });
}

/** Сколько разрешений доступно прямо сейчас, без списания. Нужно для наблюдаемости очереди. */
export async function inspect(supplier) {
  await ensureBucket(supplier);
  const { rows } = await pool.query(
    `SELECT l.supplier, l.capacity, l.window_ms, l.granted,
            GREATEST(l.capacity - (
              SELECT count(*)::int FROM supplier_rate_events e
               WHERE e.supplier = l.supplier
                 AND e.granted_at > now() - (l.window_ms * ${1 + SAFETY_MARGIN} || ' milliseconds')::interval), 0) AS available
       FROM supplier_rate_limits l WHERE l.supplier = $1`,
    [supplier],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    supplier: r.supplier,
    capacity: r.capacity,
    window_ms: r.window_ms,
    available: Number(r.available),
    granted_total: Number(r.granted),
  };
}

/** Журнал разрешений нужен только на ширину окна: всё, что старше, чистится фоном. */
export async function pruneRateEvents() {
  await pool.query(
    `DELETE FROM supplier_rate_events e
       USING supplier_rate_limits l
      WHERE l.supplier = e.supplier
        AND e.granted_at < now() - (l.window_ms * 3 || ' milliseconds')::interval`,
  );
}
