import express from 'express';
import { ordersRouter } from './routes/orders.js';
import { webhooksRouter } from './routes/webhooks.js';
import { catalogRouter } from './routes/catalog.js';
import { adminRouter } from './routes/admin.js';
import { log } from './logger.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use(ordersRouter);
  app.use(webhooksRouter);
  app.use(catalogRouter);
  app.use(adminRouter);

  app.use((err, req, res, _next) => {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    log.error('http.unhandled', { path: req.path, error: err.message, stack: err.stack });
    // 5xx осознанно: платёжная система по контракту повторит доставку вебхука.
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
