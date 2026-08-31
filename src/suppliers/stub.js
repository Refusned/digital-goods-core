import express from 'express';
import { pool } from '../db.js';
import { log } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Заглушка внешнего поставщика кодов.
 *
 * Контракт (из задания):
 *   POST /issue { request_id, sku, order_id } -> 200 { status: "ok", request_id, code }
 *                                            -> 4xx/5xx { status: "error", reason }
 *                                            -> либо вообще не отвечает (таймаут)
 *
 * Главное: повтор с тем же request_id обязан вернуть ТОТ ЖЕ код.
 * Поэтому "зависание" здесь честное: заглушка сначала РЕЗЕРВИРУЕТ код, а потом уже зависает.
 * Именно так возникает ловушка "таймаут не равен отказу".
 */
export function createSupplierStub({ name, errorRate = 0, timeoutRate = 0, hangMs = 5000 }) {
  const app = express();
  app.use(express.json());

  const chaos = { errorRate, timeoutRate, hangMs, script: [] };

  // Управление сбоями на лету: доля ошибок/таймаутов либо детерминированный сценарий.
  app.post('/_chaos', (req, res) => {
    const { errorRate: e, timeoutRate: t, hangMs: h, script } = req.body || {};
    if (e !== undefined) chaos.errorRate = Number(e);
    if (t !== undefined) chaos.timeoutRate = Number(t);
    if (h !== undefined) chaos.hangMs = Number(h);
    if (script !== undefined) chaos.script = Array.isArray(script) ? [...script] : [];
    res.json({ supplier: name, chaos });
  });

  app.get('/_stats', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE taken_by IS NULL)::int AS free
         FROM supplier_stub.keys WHERE supplier = $1`,
      [name],
    );
    const issued = await pool.query('SELECT count(*)::int AS issued FROM supplier_stub.issued WHERE supplier = $1', [name]);
    res.json({ supplier: name, ...rows[0], issued: issued.rows[0].issued, chaos });
  });

  // Пополнение пула: сценарий "остаток закончился, потом завезли".
  app.post('/_restock', async (req, res) => {
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];
    for (const code of codes) {
      await pool.query(
        'INSERT INTO supplier_stub.keys (supplier, code) VALUES ($1, $2) ON CONFLICT (supplier, code) DO NOTHING',
        [name, code],
      );
    }
    res.json({ supplier: name, added: codes.length });
  });

  app.post('/issue', async (req, res) => {
    const { request_id: requestId, sku, order_id: orderId } = req.body || {};
    if (!requestId) return res.status(400).json({ status: 'error', reason: 'request_id_required' });

    // 1. Идемпотентность поставщика: тот же request_id -> тот же код, без нового резерва.
    const seen = await pool.query('SELECT code FROM supplier_stub.issued WHERE request_id = $1', [requestId]);
    if (seen.rowCount > 0) {
      const behaviour = nextBehaviour(chaos, { repeat: true });
      log.debug('supplier.repeat', { supplier: name, request_id: requestId, behaviour });
      if (behaviour === 'timeout' || behaviour === 'timeout_issue') {
        await sleep(chaos.hangMs);
      }
      return res.json({ status: 'ok', request_id: requestId, code: seen.rows[0].code, repeated: true });
    }

    const behaviour = nextBehaviour(chaos, { repeat: false });

    if (behaviour === 'error') {
      log.debug('supplier.error', { supplier: name, request_id: requestId });
      return res.status(503).json({ status: 'error', reason: 'supplier_unavailable' });
    }

    // 2. Резервируем свободный ключ. SKIP LOCKED -> параллельные запросы не дерутся за одну строку.
    const claimed = await pool.query(
      `UPDATE supplier_stub.keys
          SET taken_by = $2
        WHERE id = (SELECT id FROM supplier_stub.keys
                     WHERE supplier = $1 AND taken_by IS NULL
                     ORDER BY id
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1)
      RETURNING code`,
      [name, requestId],
    );

    if (claimed.rowCount === 0) {
      log.debug('supplier.out_of_stock', { supplier: name, request_id: requestId, sku });
      return res.status(409).json({ status: 'error', reason: 'out_of_stock' });
    }

    const code = claimed.rows[0].code;
    await pool.query(
      `INSERT INTO supplier_stub.issued (request_id, supplier, order_id, sku, code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id) DO NOTHING`,
      [requestId, name, orderId ?? null, sku ?? null, code],
    );

    // 3. Ловушка: код уже выдан, а ответ до клиента не доедет.
    if (behaviour === 'timeout' || behaviour === 'timeout_issue') {
      log.debug('supplier.hang_after_issue', { supplier: name, request_id: requestId, code });
      await sleep(chaos.hangMs);
    }

    log.debug('supplier.issued', { supplier: name, request_id: requestId, code });
    return res.json({ status: 'ok', request_id: requestId, code });
  });

  return app;
}

function nextBehaviour(chaos, { repeat }) {
  if (chaos.script.length > 0) return chaos.script.shift();
  if (Math.random() < chaos.errorRate && !repeat) return 'error';
  if (Math.random() < chaos.timeoutRate) return 'timeout_issue';
  return 'ok';
}
