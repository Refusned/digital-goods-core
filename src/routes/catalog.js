import { Router } from 'express';
import { pool } from '../db.js';

export const catalogRouter = Router();

/**
 * Горячий запрос витрины: "что есть в наличии, по популярности".
 * Полностью закрыт частичным составным индексом
 * products (type, popularity DESC, sku) WHERE is_active AND in_stock,
 * поэтому остаётся быстрым и на тысячах SKU: index scan + limit, без сортировки и без чтения товаров не в наличии.
 */
catalogRouter.get('/catalog', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    const type = req.query.type || null;

    const { rows } = type
      ? await pool.query(
          `SELECT p.sku, p.name, p.type, p.price_minor, p.currency, p.image, p.popularity, s.available
             FROM products p
             LEFT JOIN product_stock s ON s.sku = p.sku
            WHERE p.is_active AND p.in_stock AND p.type = $1
            ORDER BY p.popularity DESC, p.sku
            LIMIT $2`,
          [type, limit],
        )
      : await pool.query(
          `SELECT p.sku, p.name, p.type, p.price_minor, p.currency, p.image, p.popularity, s.available
             FROM products p
             LEFT JOIN product_stock s ON s.sku = p.sku
            WHERE p.is_active AND p.in_stock
            ORDER BY p.popularity DESC, p.sku
            LIMIT $1`,
          [limit],
        );

    res.json({
      items: rows.map((r) => ({
        sku: r.sku, name: r.name, type: r.type,
        price: r.price_minor, currency: r.currency,
        image: r.image, available: r.available ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/catalog/:sku', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.sku, p.name, p.type, p.price_minor, p.currency, p.image, p.is_active, s.available
         FROM products p LEFT JOIN product_stock s ON s.sku = p.sku
        WHERE p.sku = $1`,
      [req.params.sku],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'product_not_found' });
    const r = rows[0];
    res.json({ sku: r.sku, name: r.name, type: r.type, price: r.price_minor, currency: r.currency, image: r.image, available: r.available ?? 0, is_active: r.is_active });
  } catch (err) {
    next(err);
  }
});
