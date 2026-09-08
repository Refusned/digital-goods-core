/**
 * Автоматический разбор расхождений с поставщиком.
 *
 * Поставщику нельзя верить, поэтому недостаточно правильно реагировать на его ответы:
 * нужно ещё независимо сверять его журнал выдач со своими выдачами. Сверка находит
 * то, о чём поставщик молчит, и чинит это сама, без ручного вмешательства:
 *
 *   lost_code    поставщик считает код выданным нам, а у нас выдачи нет
 *                (процесс упал между ответом и записью) -> код подбирается и доводится до покупателя;
 *   orphan_issue поставщик числит за нами код, который нам не нужен
 *                (запрос отбракован, позиция уже закрыта, запроса вообще не было) -> код возвращается на склад;
 *   silent_issue поставщик ответил ошибкой или молчанием, но код выдал
 *                (ловится ещё в момент выдачи, здесь остаётся как факт для отчёта).
 *
 * Инцидент фиксируется один раз: уникальный индекс по (supplier, kind, request_id, code)
 * не даёт одному и тому же расхождению плодиться при каждом проходе.
 */

import { pool } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { fetchJournal, releaseCode, verifyCode } from '../suppliers/client.js';

const suppliers = () => [config.suppliers.a, config.suppliers.b];

export async function recordDiscrepancy({ supplier, kind, requestId = null, itemId = null, code = null, detail = {}, resolution = null }) {
  const { rows } = await pool.query(
    `INSERT INTO supplier_discrepancies (supplier, kind, request_id, order_item_id, code, detail, resolution, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (supplier, kind, COALESCE(request_id, ''), COALESCE(code, ''))
     DO UPDATE SET detail = EXCLUDED.detail,
                   resolution = COALESCE(EXCLUDED.resolution, supplier_discrepancies.resolution),
                   resolved_at = COALESCE(supplier_discrepancies.resolved_at, EXCLUDED.resolved_at)
     RETURNING id`,
    [supplier, kind, requestId, itemId, code, JSON.stringify(detail), resolution],
  );
  return rows[0].id;
}

/** Один проход сверки по всем поставщикам. Возвращает сводку найденного и починенного. */
export async function reconcileSuppliers() {
  const summary = { checked: 0, attached: 0, released: 0, found: [] };
  for (const supplier of suppliers()) {
    const part = await reconcileSupplier(supplier);
    summary.checked += part.checked;
    summary.attached += part.attached;
    summary.released += part.released;
    summary.found.push(...part.found);
  }
  await retryPendingReleases();
  return summary;
}

async function reconcileSupplier(supplier) {
  const result = { checked: 0, attached: 0, released: 0, found: [] };

  const state = await pool.query(
    `INSERT INTO supplier_sync_state (supplier) VALUES ($1)
     ON CONFLICT (supplier) DO UPDATE SET supplier = EXCLUDED.supplier
     RETURNING cursor_id`,
    [supplier.name],
  );
  const cursor = Number(state.rows[0].cursor_id);

  const journal = await fetchJournal(supplier, cursor);
  if (!journal) return result;   // поставщик недоступен: курсор не двигаем, вернёмся позже

  let advanced = cursor;
  for (const entry of journal.items) {
    result.checked += 1;
    // Курсор двигаем только по записям, разбор которых завершён: иначе расхождение
    // проскочит мимо сверки навсегда.
    const settled = await inspectJournalEntry(supplier, entry, result);
    if (settled) advanced = Number(entry.seq);
    else break;
  }

  if (advanced !== cursor) {
    await pool.query(
      'UPDATE supplier_sync_state SET cursor_id = $2, synced_at = now() WHERE supplier = $1',
      [supplier.name, advanced],
    );
  }
  return result;
}

/**
 * Разбор одной записи журнала поставщика.
 * Возвращает true, если запись разобрана окончательно и курсор можно двигать.
 */
async function inspectJournalEntry(supplier, entry, result) {
  if (entry.released_at) return true;                       // код уже вернулся на склад

  const ours = await pool.query(
    `SELECT sr.*, i.sku AS item_sku, i.status AS item_status, i.order_id,
            d.code AS delivered_code, d.order_item_id AS delivered_item
       FROM supplier_requests sr
       LEFT JOIN order_items i ON i.id = sr.order_item_id
       LEFT JOIN deliveries d  ON d.order_item_id = sr.order_item_id
      WHERE sr.request_id = $1`,
    [entry.request_id],
  );
  const req = ours.rows[0];

  // Запроса не было вовсе: поставщик приписал нам чужую выдачу.
  if (!req) {
    await recordDiscrepancy({
      supplier: supplier.name, kind: 'orphan_issue', requestId: entry.request_id, code: entry.code,
      detail: { reason: 'запроса с таким request_id мы не делали' },
    });
    return await release(supplier, entry, result, 'код возвращён на склад: такого запроса не было');
  }

  // Код уже у покупателя по этой же позиции: всё сходится.
  if (req.delivered_code === entry.code) return true;

  // Позиция уже получила ДРУГОЙ код или закрыта: этот код нам не нужен.
  if (req.delivered_item || ['delivered', 'refunded'].includes(req.item_status) || req.state === 'rejected') {
    await recordDiscrepancy({
      supplier: supplier.name, kind: 'orphan_issue', requestId: entry.request_id,
      itemId: req.order_item_id, code: entry.code,
      detail: { item_status: req.item_status, delivered_code: req.delivered_code, request_state: req.state },
    });
    return await release(supplier, entry, result, 'код возвращён на склад: позиции он больше не нужен');
  }

  // Позиция ждёт код, а он, оказывается, давно выдан. Забираем.
  if (['pending', 'delivering'].includes(req.item_status)) {
    const check = await verifyCode(supplier, entry.code);
    if (check === null) return false;                        // спросить не удалось, вернёмся к этой записи позже

    if (check.status === 'known' && check.sku && check.sku !== req.item_sku) {
      await recordDiscrepancy({
        supplier: supplier.name, kind: 'foreign_code', requestId: entry.request_id,
        itemId: req.order_item_id, code: entry.code,
        detail: { expected_sku: req.item_sku, got_sku: check.sku },
      });
      return await release(supplier, entry, result, 'чужой код возвращён на склад');
    }

    await recordDiscrepancy({
      supplier: supplier.name, kind: 'lost_code', requestId: entry.request_id,
      itemId: req.order_item_id, code: entry.code,
      detail: { request_state: req.state, item_status: req.item_status },
    });

    // Помечаем запрос успешным с этим кодом и отдаём выдачу обычному пути:
    // он проверит уникальность кода, спишет деньги и закроет заказ.
    await pool.query(
      `UPDATE supplier_requests SET state = 'ok', code = $2, reason = 'recovered_by_audit', updated_at = now()
        WHERE request_id = $1`,
      [entry.request_id, entry.code],
    );
    const { deliverItem } = await import('./delivery.js');
    const delivered = await deliverItem(req.order_item_id, { trigger: 'audit' });

    if (delivered.outcome === 'delivered' || delivered.outcome === 'already_delivered') {
      result.attached += 1;
      result.found.push({ kind: 'lost_code', request_id: entry.request_id, resolution: 'delivered' });
      await pool.query(
        `UPDATE supplier_discrepancies
            SET resolution = 'код подобран сверкой и выдан покупателю', resolved_at = now()
          WHERE supplier = $1 AND kind = 'lost_code' AND request_id = $2`,
        [supplier.name, entry.request_id],
      );
      return true;
    }

    // Временная помеха (лимит, блокировка, неопределённость у поставщика): вернёмся к записи позже.
    if (['rate_limited', 'retry_later', 'locked'].includes(delivered.outcome)) return false;

    // Выдать этот код позиции нельзя в принципе: она уже закрыта или код оказался дублем.
    // Держать инцидент открытым бессмысленно, он бы навсегда застопорил и курсор сверки.
    await pool.query(
      `UPDATE supplier_requests SET state = 'rejected', rejected_code = $2, reason = 'audit_undeliverable', updated_at = now()
        WHERE request_id = $1`,
      [entry.request_id, entry.code],
    );
    await pool.query(
      `UPDATE supplier_discrepancies
          SET resolution = $3, resolved_at = now()
        WHERE supplier = $1 AND kind = 'lost_code' AND request_id = $2`,
      [supplier.name, entry.request_id, `выдать код позиции нельзя (${delivered.outcome}), код возвращён на склад`],
    );
    return await release(supplier, entry, result, 'код возвращён на склад: позиции он не подошёл');
  }

  return true;
}

async function release(supplier, entry, result, resolution) {
  const released = await releaseCode(supplier, entry.request_id);
  if (!released) return false;
  result.released += 1;
  result.found.push({ kind: 'orphan_issue', request_id: entry.request_id, resolution });
  await pool.query(
    `UPDATE supplier_requests SET released_at = now(), updated_at = now() WHERE request_id = $1`,
    [entry.request_id],
  );
  await pool.query(
    `UPDATE supplier_discrepancies SET resolution = $3, resolved_at = now()
      WHERE supplier = $1 AND request_id = $2 AND resolved_at IS NULL`,
    [supplier.name, entry.request_id, resolution],
  );
  log.info('supplier.code_released', { supplier: supplier.name, request_id: entry.request_id });
  return true;
}

/**
 * Отбракованные коды, которые не удалось вернуть сразу (поставщик был недоступен).
 * Без этого прохода товар навсегда оставался бы числиться израсходованным.
 */
async function retryPendingReleases() {
  const { rows } = await pool.query(
    `SELECT request_id, supplier FROM supplier_requests
      WHERE state = 'rejected' AND released_at IS NULL
      ORDER BY updated_at LIMIT 50`,
  );
  for (const row of rows) {
    const supplier = suppliers().find((s) => s.name === row.supplier);
    if (!supplier) continue;
    const released = await releaseCode(supplier, row.request_id);
    if (released) {
      await pool.query('UPDATE supplier_requests SET released_at = now() WHERE request_id = $1', [row.request_id]);
    }
  }
}

/** Открытые расхождения для админского отчёта. */
export async function discrepancyReport({ limit = 100 } = {}) {
  const open = await pool.query(
    `SELECT * FROM supplier_discrepancies WHERE resolved_at IS NULL ORDER BY detected_at DESC LIMIT $1`, [limit]);
  const recent = await pool.query(
    `SELECT * FROM supplier_discrepancies WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT $1`, [limit]);
  const byKind = await pool.query(
    `SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
       FROM supplier_discrepancies GROUP BY kind ORDER BY kind`,
  );
  return {
    open_count: open.rowCount,
    by_kind: byKind.rows,
    open: open.rows,
    recently_resolved: recent.rows,
  };
}
