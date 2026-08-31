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
