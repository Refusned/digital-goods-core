import { pool } from './db.js';
import { config } from './config.js';
import { log } from './logger.js';
import { deliverOrder, syncStock } from './services/delivery.js';
import { applyEvent } from './services/payments.js';

/**
 * Фоновое восстановление. Единственный компонент, который доводит систему до целевого состояния,
 * что бы ни случилось с процессом в момент обработки вебхука.
 *
 * Заказы забираются в аренду через FOR UPDATE SKIP LOCKED: несколько экземпляров сервиса
 * делят очередь, а не молотят одно и то же.
 */
export function startWorker({ intervalMs = config.worker.intervalMs } = {}) {
  let stopped = false;
  let running = false;
  const leaseMs = Math.max(2 * intervalMs, 1000);

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await applyOrphanEvents();
      await pushStuckOrders(leaseMs);
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
 * Аренда тут не нужна: applyEvent сам берёт строку события FOR UPDATE и идемпотентен,
 * так что параллельный воркер в худшем случае сделает лишний холостой заход.
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
  for (const row of rows) {
    const res = await applyEvent(row.event_id);
    if (res.deliver && res.orderId) await deliverOrder(res.orderId, { trigger: 'worker.event' });
  }
}

/**
 * Заказы, застрявшие между оплатой и выдачей.
 * Выборка и аренда идут одним запросом: SKIP LOCKED разводит экземпляры сервиса,
 * а сдвиг next_attempt_at не даёт соседу схватить тот же заказ, пока мы с ним работаем.
 */
async function pushStuckOrders(leaseMs) {
  const { rows } = await pool.query(
    `WITH picked AS (
        SELECT id FROM orders
         WHERE (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND (
                 (status IN ('paid', 'delivering', 'delivery_failed') AND attempts < $1)
                 -- "нет остатка" ждёт завоза сколько нужно: лимит попыток тут не применяется
                 OR status = 'out_of_stock'
               )
         ORDER BY paid_at
         FOR UPDATE SKIP LOCKED
         LIMIT 20
     )
     UPDATE orders o
        SET next_attempt_at = now() + ($2 || ' milliseconds')::interval
       FROM picked
      WHERE o.id = picked.id
     RETURNING o.id, o.sku, o.status`,
    [config.worker.maxAttempts, String(leaseMs)],
  );

  for (const row of rows) {
    // Нет остатка: сначала сверяем витрину со складами поставщиков, вдруг уже завезли.
    if (row.status === 'out_of_stock') await syncStock(row.sku);
    const result = await deliverOrder(row.id, { trigger: 'worker.stuck' });
    if (result.outcome === 'delivered') log.info('worker.recovered', { order_id: row.id });
  }
}
