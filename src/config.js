import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Крошечный загрузчик .env, чтобы не тащить зависимость ради пяти переменных.
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (v, def) => (v === undefined || v === '' ? def : Number(v));

export const config = {
  root,
  port: num(process.env.PORT, 3010),
  databaseUrl: process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop',
  suppliers: {
    a: {
      name: 'A',
      port: num(process.env.SUPPLIER_A_PORT, 3121),
      get baseUrl() { return process.env.SUPPLIER_A_URL || `http://127.0.0.1:${this.port}`; },
      errorRate: num(process.env.SUPPLIER_A_ERROR_RATE, 0),
      timeoutRate: num(process.env.SUPPLIER_A_TIMEOUT_RATE, 0),
    },
    b: {
      name: 'B',
      port: num(process.env.SUPPLIER_B_PORT, 3122),
      get baseUrl() { return process.env.SUPPLIER_B_URL || `http://127.0.0.1:${this.port}`; },
      errorRate: num(process.env.SUPPLIER_B_ERROR_RATE, 0),
      timeoutRate: num(process.env.SUPPLIER_B_TIMEOUT_RATE, 0),
    },
  },
  supplierTimeoutMs: num(process.env.SUPPLIER_TIMEOUT_MS, 1500),
  supplierMaxAttempts: num(process.env.SUPPLIER_MAX_ATTEMPTS, 3),
  supplierBackoffBaseMs: num(process.env.SUPPLIER_BACKOFF_BASE_MS, 200),

  // Заглушка платёжного шлюза: через неё уходят возвраты за невыданные позиции.
  payments: {
    port: num(process.env.PAYMENT_STUB_PORT, 3131),
    get baseUrl() { return process.env.PAYMENT_STUB_URL || `http://127.0.0.1:${this.port}`; },
    timeoutMs: num(process.env.PAYMENT_TIMEOUT_MS, 1500),
  },

  // Приоритет обслуживания под лимитом поставщика: деньги покупателя важнее резерва до оплаты.
  priority: {
    paid: num(process.env.PRIORITY_PAID, 0),
    unpaid: num(process.env.PRIORITY_UNPAID, 100),
  },

  delivery: {
    // Сколько позиция вправе ждать код, прежде чем её объявят невыдаваемой и вернут деньги.
    // Бесконечное ожидание это тоже способ потерять деньги покупателя.
    deadlineMs: num(process.env.DELIVERY_DEADLINE_MS, 120_000),
    maxItemAttempts: num(process.env.DELIVERY_MAX_ITEM_ATTEMPTS, 8),
    // Сколько раз подряд разрешено просить у поставщика ЗАМЕНУ негодного кода (дубль, чужой).
    maxCodeRejections: num(process.env.DELIVERY_MAX_CODE_REJECTIONS, 3),
    // Сколько позиций диспетчер забирает за один проход.
    batchSize: num(process.env.DELIVERY_BATCH_SIZE, 40),
    concurrency: num(process.env.DELIVERY_CONCURRENCY, 8),
  },

  refunds: {
    maxAttempts: num(process.env.REFUND_MAX_ATTEMPTS, 20),
    retryMs: num(process.env.REFUND_RETRY_MS, 2000),
  },

  // Лимит запросов к поставщику. Известен нам заранее по договору, поэтому мы обязаны
  // не превышать его сами, а не узнавать об этом из 429.
  rateLimit: {
    enabled: process.env.SUPPLIER_RATE_LIMIT_ENABLED !== '0',
    capacity: num(process.env.SUPPLIER_RATE_CAPACITY, 60),
    windowMs: num(process.env.SUPPLIER_RATE_WINDOW_MS, 60_000),
  },

  reconciler: {
    enabled: process.env.SUPPLIER_RECONCILER_ENABLED !== '0',
    intervalMs: num(process.env.SUPPLIER_RECONCILER_INTERVAL_MS, 2000),
  },
  worker: {
    enabled: process.env.WORKER_ENABLED !== '0',
    intervalMs: num(process.env.WORKER_INTERVAL_MS, 1000),
    maxAttempts: num(process.env.WORKER_MAX_ATTEMPTS, 10),
    // Нет остатка это не ошибка нашей системы: поставщик может завезти в любой момент,
    // поэтому такие заказы ретраятся бессрочно, но редко.
    outOfStockRetryMs: num(process.env.OUT_OF_STOCK_RETRY_MS, 5000),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
