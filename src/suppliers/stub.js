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
 * Главное требование: повтор с тем же request_id обязан вернуть ТОТ ЖЕ код.
 * Поэтому весь путь (проверка выданного, резерв ключа, фиксация) идёт ОДНОЙ транзакцией
 * с сериализацией по request_id: параллельные повторы одного request_id не могут
 * зарезервировать разные ключи.
 *
 * "Зависание" здесь честное: код резервируется, а ответ не доходит. Так возникает
 * ловушка "таймаут не равен отказу".
 */
export function createSupplierStub({ name, errorRate = 0, timeoutRate = 0, hangMs = 5000 }) {
  const app = express();
  app.use(express.json());

  const chaos = { errorRate, timeoutRate, hangMs, script: [] };

  // Управление сбоями на лету: доля ошибок и таймаутов либо детерминированный сценарий.
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

  /** Остатки по товарам: ядро синхронизирует по ним витрину. */
  app.get('/stock', async (req, res) => {
    const sku = req.query.sku || null;
    const { rows } = sku
      ? await pool.query(
          `SELECT sku, count(*) FILTER (WHERE taken_by IS NULL)::int AS available
             FROM supplier_stub.keys WHERE supplier = $1 AND sku = $2 GROUP BY sku`,
          [name, sku],
        )
      : await pool.query(
          `SELECT sku, count(*) FILTER (WHERE taken_by IS NULL)::int AS available
             FROM supplier_stub.keys WHERE supplier = $1 GROUP BY sku ORDER BY sku`,
          [name],
        );
    res.json({ supplier: name, items: rows });
  });

  // Пополнение пула: сценарий "остаток закончился, потом завезли".
  app.post('/_restock', async (req, res) => {
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];
    const sku = req.body?.sku ?? null;
    let added = 0;
    for (const code of codes) {
      const r = await pool.query(
        `INSERT INTO supplier_stub.keys (supplier, sku, code) VALUES ($1, $2, $3)
         ON CONFLICT (supplier, code) DO NOTHING RETURNING id`,
        [name, sku, code],
      );
      added += r.rowCount;
    }
    res.json({ supplier: name, sku, added });
  });

  app.post('/issue', async (req, res) => {
    const { request_id: requestId, sku, order_id: orderId } = req.body || {};
    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ status: 'error', reason: 'request_id_required' });
    }

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      // Сериализация по request_id: параллельные повторы одного запроса идут строго друг за другом.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [requestId]);

      const seen = await client.query('SELECT code FROM supplier_stub.issued WHERE request_id = $1', [requestId]);
      if (seen.rowCount > 0) {
        await client.query('COMMIT');
        result = { kind: 'repeat', code: seen.rows[0].code };
      } else {
        const behaviour = nextBehaviour(chaos);

        if (behaviour === 'error') {
          await client.query('ROLLBACK');
          result = { kind: 'error' };
        } else {
          // Резервируем свободный ключ нужного товара. SKIP LOCKED разводит параллельные заказы.
          const claimed = await client.query(
            `UPDATE supplier_stub.keys
                SET taken_by = $2
              WHERE id = (SELECT id FROM supplier_stub.keys
                           WHERE supplier = $1 AND taken_by IS NULL AND ($3::text IS NULL OR sku = $3)
                           ORDER BY id
                           FOR UPDATE SKIP LOCKED
                           LIMIT 1)
            RETURNING code`,
            [name, requestId, sku ?? null],
          );

          if (claimed.rowCount === 0) {
            await client.query('ROLLBACK');
            result = { kind: 'out_of_stock' };
          } else {
            const code = claimed.rows[0].code;
            await client.query(
              `INSERT INTO supplier_stub.issued (request_id, supplier, order_id, sku, code)
               VALUES ($1, $2, $3, $4, $5)`,
              [requestId, name, orderId ?? null, sku ?? null, code],
            );
            await client.query('COMMIT');
            result = { kind: 'issued', code, behaviour };
          }
        }
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('supplier.issue_failed', { supplier: name, request_id: requestId, error: err.message });
      client.release();
      return res.status(500).json({ status: 'error', reason: 'internal_error' });
    }
    client.release();

    if (result.kind === 'error') {
      log.debug('supplier.error', { supplier: name, request_id: requestId });
      return res.status(503).json({ status: 'error', reason: 'supplier_unavailable' });
    }
    if (result.kind === 'out_of_stock') {
      log.debug('supplier.out_of_stock', { supplier: name, request_id: requestId, sku });
      return res.status(409).json({ status: 'error', reason: 'out_of_stock' });
    }

    // Ловушка: код уже зафиксирован за request_id, а ответ до клиента не доедет.
    const hang = result.kind === 'repeat'
      ? nextBehaviour(chaos, { repeat: true })
      : result.behaviour;
    if (hang === 'timeout' || hang === 'timeout_issue') {
      log.debug('supplier.hang_after_issue', { supplier: name, request_id: requestId });
      await sleep(chaos.hangMs);
    }

    log.debug('supplier.issued', { supplier: name, request_id: requestId, repeated: result.kind === 'repeat' });
    return res.json({ status: 'ok', request_id: requestId, code: result.code, repeated: result.kind === 'repeat' });
  });

  return app;
}

function nextBehaviour(chaos, { repeat = false } = {}) {
  if (chaos.script.length > 0) return chaos.script.shift();
  if (!repeat && Math.random() < chaos.errorRate) return 'error';
  if (Math.random() < chaos.timeoutRate) return 'timeout_issue';
  return 'ok';
}
