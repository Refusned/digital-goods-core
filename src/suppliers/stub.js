import express from 'express';
import { pool } from '../db.js';
import { log } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Заглушка внешнего поставщика кодов.
 *
 * Контракт:
 *   POST /issue { request_id, sku, order_id } -> 200 { status: "ok", request_id, code }
 *                                            -> 4xx/5xx { status: "error", reason }
 *                                            -> либо вообще не отвечает (таймаут)
 *   GET  /issued/:request_id                 -> что поставщик считает выданным по запросу
 *   GET  /journal?after=&limit=              -> журнал выдач с курсором, для сверки
 *   GET  /verify?code=                       -> кому и на какой товар выдан код
 *   POST /release { request_id }             -> вернуть на склад код, который мы отбраковали
 *
 * Второй этап требует поставщика, которому НЕЛЬЗЯ доверять. Поэтому заглушка умеет:
 *   duplicate_code    выдать код, который уже выдавала другому запросу;
 *   foreign_code      выдать код от другого товара;
 *   error_after_issue зафиксировать выдачу и ответить ошибкой;
 *   timeout_issue     зафиксировать выдачу и не ответить вовсе;
 *   rateLimitPerMin   отвечать 429 при превышении лимита.
 *
 * Всё это поведение поставщика, а не наше: защита от него живёт в ядре.
 */
export function createSupplierStub({ name, errorRate = 0, timeoutRate = 0, hangMs = 5000, rateLimitPerMin = 0, rateLimitWindowMs = 60_000 }) {
  const app = express();
  app.use(express.json());

  const chaos = { errorRate, timeoutRate, hangMs, script: [], rateLimitPerMin, rateLimitWindowMs };
  // Скользящее окно вызовов /issue. Лимит нормирует именно выдачи, служебные ручки не считаются.
  const callTimes = [];
  const stats = { issue_calls: 0, rate_limited: 0, issued: 0, duplicates: 0, foreign: 0 };

  app.post('/_chaos', (req, res) => {
    const { errorRate: e, timeoutRate: t, hangMs: h, script, rateLimitPerMin: r, rateLimitWindowMs: w, resetStats } = req.body || {};
    if (resetStats) for (const key of Object.keys(stats)) stats[key] = 0;
    if (e !== undefined) chaos.errorRate = Number(e);
    if (t !== undefined) chaos.timeoutRate = Number(t);
    if (h !== undefined) chaos.hangMs = Number(h);
    if (w !== undefined) { chaos.rateLimitWindowMs = Number(w); callTimes.length = 0; }
    if (r !== undefined) { chaos.rateLimitPerMin = Number(r); callTimes.length = 0; }
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
    const issued = await pool.query(
      `SELECT count(*)::int AS issued FROM supplier_stub.issued WHERE supplier = $1 AND released_at IS NULL`,
      [name],
    );
    res.json({ supplier: name, ...rows[0], issued: issued.rows[0].issued, calls: { ...stats }, chaos });
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

  /**
   * Что поставщик считает выданным по конкретному запросу.
   * Ключевая ручка второго этапа: она позволяет НЕ верить ответу об ошибке
   * и выяснить, был ли на самом деле выдан код.
   */
  app.get('/issued/:requestId', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT request_id, code, sku, order_id, released_at, created_at
         FROM supplier_stub.issued WHERE supplier = $1 AND request_id = $2`,
      [name, req.params.requestId],
    );
    if (rows.length === 0) return res.json({ supplier: name, status: 'none' });
    res.json({ supplier: name, status: rows[0].released_at ? 'released' : 'issued', ...rows[0] });
  });

  /** Журнал выдач с курсором: по нему ядро находит расхождения, о которых поставщик молчит. */
  app.get('/journal', async (req, res) => {
    const after = Number(req.query.after || 0);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const { rows } = await pool.query(
      `SELECT seq, request_id, code, sku, order_id, released_at, created_at
         FROM supplier_stub.issued
        WHERE supplier = $1 AND seq > $2
        ORDER BY seq LIMIT $3`,
      [name, after, limit],
    );
    res.json({ supplier: name, items: rows, next_cursor: rows.length ? Number(rows[rows.length - 1].seq) : after });
  });

  /** Проверка принадлежности кода: он вообще с нашего склада и от того ли товара. */
  app.get('/verify', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ status: 'error', reason: 'code_required' });
    const key = await pool.query(
      'SELECT sku, taken_by FROM supplier_stub.keys WHERE supplier = $1 AND code = $2', [name, code]);
    if (key.rowCount === 0) return res.json({ supplier: name, status: 'unknown_code' });
    const issued = await pool.query(
      `SELECT request_id, order_id, released_at FROM supplier_stub.issued
        WHERE supplier = $1 AND code = $2 ORDER BY seq LIMIT 1`,
      [name, code],
    );
    res.json({
      supplier: name,
      status: 'known',
      code,
      sku: key.rows[0].sku,
      issued_to_request: issued.rows[0]?.request_id ?? null,
      order_id: issued.rows[0]?.order_id ?? null,
    });
  });

  /**
   * Возврат отбракованного кода на склад.
   * Без этой ручки каждый негодный ответ поставщика съедал бы товар: код числился бы
   * израсходованным, но никому не выданным.
   */
  app.post('/release', async (req, res) => {
    const requestId = req.body?.request_id;
    if (!requestId) return res.status(400).json({ status: 'error', reason: 'request_id_required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [requestId]);
      const found = await client.query(
        `SELECT code, released_at FROM supplier_stub.issued WHERE supplier = $1 AND request_id = $2`,
        [name, requestId],
      );
      if (found.rowCount === 0) {
        await client.query('COMMIT');
        return res.json({ supplier: name, status: 'none' });
      }
      if (found.rows[0].released_at) {
        await client.query('COMMIT');
        return res.json({ supplier: name, status: 'already_released', code: found.rows[0].code });
      }
      const code = found.rows[0].code;
      await client.query(
        `UPDATE supplier_stub.issued SET released_at = now() WHERE supplier = $1 AND request_id = $2`,
        [name, requestId],
      );
      // Ключ возвращается на склад, только если его больше никто не держит.
      const stillHeld = await client.query(
        `SELECT 1 FROM supplier_stub.issued
          WHERE supplier = $1 AND code = $2 AND released_at IS NULL LIMIT 1`,
        [name, code],
      );
      if (stillHeld.rowCount === 0) {
        await client.query('UPDATE supplier_stub.keys SET taken_by = NULL WHERE supplier = $1 AND code = $2', [name, code]);
      }
      await client.query('COMMIT');
      res.json({ supplier: name, status: 'released', code, returned_to_stock: stillHeld.rowCount === 0 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ status: 'error', reason: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/issue', async (req, res) => {
    const { request_id: requestId, sku, order_id: orderId } = req.body || {};
    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ status: 'error', reason: 'request_id_required' });
    }

    stats.issue_calls += 1;

    // Лимит проверяется до всякой работы: превысил договор, получи 429.
    if (chaos.rateLimitPerMin > 0) {
      const now = Date.now();
      const windowMs = chaos.rateLimitWindowMs || 60_000;
      while (callTimes.length && now - callTimes[0] > windowMs) callTimes.shift();
      if (callTimes.length >= chaos.rateLimitPerMin) {
        stats.rate_limited += 1;
        const retryAfterMs = windowMs - (now - callTimes[0]);
        log.debug('supplier.rate_limited', { supplier: name, request_id: requestId });
        return res.status(429).json({ status: 'error', reason: 'rate_limited', retry_after_ms: retryAfterMs });
      }
      callTimes.push(now);
    }

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      // Сериализация по request_id: параллельные повторы одного запроса идут строго друг за другом.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [requestId]);

      const seen = await client.query(
        'SELECT code, released_at FROM supplier_stub.issued WHERE request_id = $1 AND supplier = $2',
        [requestId, name],
      );
      if (seen.rowCount > 0 && !seen.rows[0].released_at) {
        await client.query('COMMIT');
        result = { kind: 'repeat', code: seen.rows[0].code };
      } else {
        const behaviour = nextBehaviour(chaos);

        if (behaviour === 'error') {
          await client.query('ROLLBACK');
          result = { kind: 'error' };
        } else if (behaviour === 'duplicate_code') {
          // Недобросовестное поведение: отдаём код, который уже уходил другому запросу.
          const prev = await client.query(
            `SELECT code, sku FROM supplier_stub.issued
              WHERE supplier = $1 AND released_at IS NULL AND request_id <> $2
              ORDER BY seq DESC LIMIT 1`,
            [name, requestId],
          );
          if (prev.rowCount === 0) {
            await client.query('ROLLBACK');
            result = { kind: 'error' };   // дублировать нечего, ведём себя как обычная ошибка
          } else {
            await client.query(
              `INSERT INTO supplier_stub.issued (request_id, supplier, order_id, sku, code)
               VALUES ($1, $2, $3, $4, $5)`,
              [requestId, name, orderId ?? null, sku ?? prev.rows[0].sku, prev.rows[0].code],
            );
            await client.query('COMMIT');
            stats.duplicates += 1;
            result = { kind: 'issued', code: prev.rows[0].code, behaviour: 'ok' };
          }
        } else if (behaviour === 'foreign_code') {
          // Недобросовестное поведение: код от ДРУГОГО товара.
          const other = await client.query(
            `UPDATE supplier_stub.keys SET taken_by = $2
              WHERE id = (SELECT id FROM supplier_stub.keys
                           WHERE supplier = $1 AND taken_by IS NULL AND sku IS DISTINCT FROM $3
                           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING code, sku`,
            [name, requestId, sku ?? null],
          );
          if (other.rowCount === 0) {
            await client.query('ROLLBACK');
            result = { kind: 'out_of_stock' };
          } else {
            await client.query(
              `INSERT INTO supplier_stub.issued (request_id, supplier, order_id, sku, code)
               VALUES ($1, $2, $3, $4, $5)`,
              [requestId, name, orderId ?? null, other.rows[0].sku, other.rows[0].code],
            );
            await client.query('COMMIT');
            stats.foreign += 1;
            result = { kind: 'issued', code: other.rows[0].code, behaviour: 'ok' };
          }
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
            stats.issued += 1;
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

    // Ловушка первого этапа: код уже зафиксирован за request_id, а ответ до клиента не доедет.
    const behaviour = result.kind === 'repeat' ? nextBehaviour(chaos, { repeat: true }) : result.behaviour;

    if (behaviour === 'error_after_issue') {
      // Ловушка второго этапа: код выдан, но поставщик отвечает ЯВНОЙ ошибкой.
      log.debug('supplier.error_after_issue', { supplier: name, request_id: requestId });
      return res.status(500).json({ status: 'error', reason: 'internal_error' });
    }
    if (behaviour === 'timeout' || behaviour === 'timeout_issue') {
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
