import express from 'express';
import { pool } from '../db.js';
import { log } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Заглушка платёжного шлюза. В первом этапе оплата приходила вебхуком, шлюз был не нужен;
 * во втором нужен возврат, а возврат это ИСХОДЯЩИЙ вызов, у которого есть свои сбои.
 *
 * Контракт:
 *   POST /refund { refund_id, order_id, amount, currency }
 *     -> 200 { status: "ok", refund_id, provider_ref }
 *     -> 5xx, либо молчание (таймаут)
 *
 * Главное требование: повтор с тем же refund_id обязан вернуть ТОТ ЖЕ provider_ref
 * и не выплатить деньги второй раз. Идемпотентность держит PRIMARY KEY по refund_id.
 */
export function createPaymentStub({ errorRate = 0, timeoutRate = 0, hangMs = 5000 } = {}) {
  const app = express();
  app.use(express.json());

  const chaos = { errorRate, timeoutRate, hangMs, script: [] };

  app.post('/_chaos', (req, res) => {
    const { errorRate: e, timeoutRate: t, hangMs: h, script } = req.body || {};
    if (e !== undefined) chaos.errorRate = Number(e);
    if (t !== undefined) chaos.timeoutRate = Number(t);
    if (h !== undefined) chaos.hangMs = Number(h);
    if (script !== undefined) chaos.script = Array.isArray(script) ? [...script] : [];
    res.json({ chaos });
  });

  app.get('/_stats', async (_req, res) => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS refunds, COALESCE(SUM(amount_minor), 0) AS amount_minor FROM payment_stub.refunds');
    res.json({ refunds: rows[0].refunds, amount_minor: Number(rows[0].amount_minor), chaos });
  });

  app.get('/refunds/:refundId', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM payment_stub.refunds WHERE refund_id = $1', [req.params.refundId]);
    if (rows.length === 0) return res.json({ status: 'none' });
    res.json({ status: 'ok', ...rows[0], amount: Number(rows[0].amount_minor) });
  });

  app.post('/refund', async (req, res) => {
    const { refund_id: refundId, order_id: orderId, amount, currency } = req.body || {};
    if (!refundId || typeof refundId !== 'string') return res.status(400).json({ status: 'error', reason: 'refund_id_required' });
    if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ status: 'error', reason: 'bad_amount' });

    const behaviour = nextBehaviour(chaos);
    if (behaviour === 'error') return res.status(503).json({ status: 'error', reason: 'gateway_unavailable' });

    const providerRef = `pr_${refundId.slice(-16)}`;
    // Повтор с тем же refund_id не создаёт вторую выплату: конфликт по первичному ключу.
    const { rows } = await pool.query(
      `INSERT INTO payment_stub.refunds (refund_id, order_id, amount_minor, currency, provider_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (refund_id) DO UPDATE SET refund_id = EXCLUDED.refund_id
       RETURNING provider_ref, (xmax <> 0) AS repeated`,
      [refundId, orderId ?? null, amount, currency ?? 'RUB', providerRef],
    );

    if (behaviour === 'timeout' || behaviour === 'timeout_refund') {
      // Ловушка: деньги ушли, а ответ не доехал. Повтор обязан быть безопасным.
      log.debug('payment.hang_after_refund', { refund_id: refundId });
      await sleep(chaos.hangMs);
    }

    res.json({ status: 'ok', refund_id: refundId, provider_ref: rows[0].provider_ref, repeated: rows[0].repeated });
  });

  return app;
}

function nextBehaviour(chaos) {
  if (chaos.script.length > 0) return chaos.script.shift();
  if (Math.random() < chaos.errorRate) return 'error';
  if (Math.random() < chaos.timeoutRate) return 'timeout_refund';
  return 'ok';
}
