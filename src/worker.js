import { pool } from './db.js';
import { config } from './config.js';
import { log } from './logger.js';
import { deliverOrder } from './services/delivery.js';
import { applyEvent } from './services/payments.js';

/**
 * Фоновое восстановление. Единственный компонент, который доводит систему до целевого состояния,
 * что бы ни случилось с процессом в момент обработки вебхука.
 *
 * Забирает работу через FOR UPDATE SKIP LOCKED, поэтому несколько экземпляров сервиса
 * не будут дублировать друг друга.
 */
export function startWorker({ intervalMs = config.worker.intervalMs } = {}) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await applyOrphanEvents();
      await pushStuckOrders();
    } catch (err) {
      log.error('worker.tick_failed', { error: err.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log.info('worker.started', { interval_ms: intervalMs });

  return async function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

/** События, пришедшие раньше заказа: как только заказ появился, применяем. */
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

/** Заказы, застрявшие между оплатой и выдачей. */
async function pushStuckOrders() {
  const { rows } = await pool.query(
    `SELECT id FROM orders
      WHERE (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND (
              (status IN ('paid', 'delivering', 'delivery_failed') AND attempts < $1)
              -- "нет остатка" ждёт завоза сколько нужно: лимит попыток тут не применяется
              OR status = 'out_of_stock'
            )
      ORDER BY paid_at
      LIMIT 20`,
    [config.worker.maxAttempts],
  );
  for (const row of rows) {
    const result = await deliverOrder(row.id, { trigger: 'worker.stuck' });
    if (result.outcome === 'delivered') log.info('worker.recovered', { order_id: row.id });
  }
}
