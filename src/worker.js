import { pool } from './db.js';
import { config } from './config.js';
import { log } from './logger.js';
import { deliverItem, syncStock } from './services/delivery.js';
import { applyEvent } from './services/payments.js';
import { refreshOrderStatus } from './services/orders.js';
import { sweepUnfulfillable, processRefunds } from './services/refunds.js';
import { reconcileSuppliers } from './services/supplier-audit.js';
import { inspect as inspectRateLimit, pruneRateEvents } from './services/ratelimit.js';

/**
 * Фоновый диспетчер. Единственный компонент, который доводит систему до целевого состояния,
 * что бы ни случилось с процессом в момент обработки вебхука.
 *
 * За один проход:
 *   1. применяет события оплаты, пришедшие раньше заказа;
 *   2. раздаёт очередь позиций к поставщикам, не превышая их лимит;
 *   3. признаёт невыдаваемым то, что исчерпало попытки или срок, и начисляет возврат;
 *   4. выплачивает накопленные возвраты;
 *   5. подводит итог заказам, у которых все позиции закрыты;
 *   6. сверяет журнал поставщика со своими выдачами (по своему, более редкому интервалу).
 *
 * Позиции забираются в аренду через FOR UPDATE SKIP LOCKED со сдвигом next_attempt_at:
 * несколько экземпляров сервиса делят очередь, а не молотят одно и то же.
 */
export function startWorker({ intervalMs = config.worker.intervalMs } = {}) {
  let stopped = false;
  let running = false;
  let lastAudit = 0;
  const leaseMs = Math.max(2 * intervalMs, 1000);

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await applyOrphanEvents();
      await dispatchQueue(leaseMs);
      await sweepUnfulfillable();
      await processRefunds();
      await finalizeOrders();
      await pruneRateEvents();

      if (config.reconciler.enabled && Date.now() - lastAudit >= config.reconciler.intervalMs) {
        lastAudit = Date.now();
        const audit = await reconcileSuppliers();
        if (audit.attached || audit.released) {
          log.info('supplier.audit', { attached: audit.attached, released: audit.released, checked: audit.checked });
        }
      }
    } catch (err) {
      log.error('worker.tick_failed', { error: err.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log.info('worker.started', { interval_ms: intervalMs, lease_ms: leaseMs });

  return async function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * События, пришедшие раньше заказа: как только заказ появился, применяем.
 * Аренда тут не нужна: applyEvent сам берёт строку события FOR UPDATE и идемпотентен.
 */
async function applyOrphanEvents() {
  const { rows } = await pool.query(
    `SELECT pe.event_id
       FROM payment_events pe
       JOIN orders o ON o.id = pe.order_id
      WHERE pe.processed_at IS NULL
      ORDER BY pe.occurred_at
      LIMIT 50`,
  );
  for (const row of rows) await applyEvent(row.event_id);
}

/**
 * Раздача очереди с соблюдением лимита поставщиков.
 *
 * Размер пачки ограничен свободными разрешениями: брать в работу больше, чем поместится
 * в лимит, бессмысленно, позиции всё равно вернутся в очередь. Лимит при этом соблюдается
 * не размером пачки, а самим захватом разрешения перед каждым запросом (см. ratelimit.js);
 * пачка нужна только чтобы не крутить впустую.
 *
 * Порядок обслуживания: сначала оплаченные (priority = 0), внутри одного приоритета
 * по времени постановки в очередь. Ничего не теряется: позиция, которой не хватило лимита,
 * остаётся в очереди и уходит на следующем проходе.
 */
async function dispatchQueue(leaseMs) {
  let budget = config.delivery.batchSize;
  if (config.rateLimit.enabled) {
    let available = 0;
    for (const supplier of [config.suppliers.a, config.suppliers.b]) {
      const bucket = await inspectRateLimit(supplier.name);
      available += bucket ? bucket.available : 0;
    }
    budget = Math.min(budget, available);
    if (budget <= 0) return;
  }

  const { rows } = await pool.query(
    `WITH picked AS (
        SELECT i.id
          FROM order_items i
          JOIN orders o ON o.id = i.order_id
         WHERE i.status IN ('pending', 'delivering')
           AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= now())
           AND (o.paid_at IS NOT NULL OR i.queued_at IS NOT NULL)
           -- позиции, исчерпавшие попытки, забирает не диспетчер, а разбор невыдаваемых
           AND (i.attempts < $1 OR COALESCE(i.last_error, '') LIKE '%out_of_stock%')
         ORDER BY i.priority, i.queued_at NULLS LAST, i.created_at
         FOR UPDATE OF i SKIP LOCKED
         LIMIT $2
     )
     UPDATE order_items x
        SET next_attempt_at = now() + ($3 || ' milliseconds')::interval
       FROM picked
      WHERE x.id = picked.id
     RETURNING x.id, x.sku, x.last_error`,
    [config.delivery.maxItemAttempts, budget, String(leaseMs)],
  );
  if (rows.length === 0) return;

  // Позиции обрабатываются параллельно ограниченным числом дорожек: всплеск не должен
  // превращаться в последовательную очередь длиной в тысячу сетевых вызовов.
  const queue = [...rows];
  const lanes = Array.from({ length: Math.min(config.delivery.concurrency, queue.length) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      // Нет остатка: сначала сверяем витрину со складами поставщиков, вдруг уже завезли.
      if (String(row.last_error || '').includes('out_of_stock')) await syncStock(row.sku);
      const result = await deliverItem(row.id, { trigger: 'worker.queue' });
      if (result.outcome === 'delivered') log.debug('worker.delivered', { item_id: row.id });
    }
  });
  await Promise.all(lanes);
}

/** Заказы, у которых все позиции закрыты, а итог ещё не подведён. */
async function finalizeOrders() {
  const { rows } = await pool.query(
    `SELECT o.id
       FROM orders o
      WHERE o.paid_at IS NOT NULL
        AND o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
        AND NOT EXISTS (
              SELECT 1 FROM order_items i
               WHERE i.order_id = o.id AND i.status IN ('pending', 'delivering', 'unfulfillable'))
      LIMIT 50`,
  );
  for (const row of rows) await refreshOrderStatus(row.id);
}
