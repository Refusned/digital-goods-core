// Импортируется ПЕРВЫМ в каждом тестовом файле: настройки должны попасть в config до его загрузки.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.WORKER_ENABLED = '0';                  // воркер тесты поднимают точечно
process.env.SUPPLIER_TIMEOUT_MS = '400';
process.env.SUPPLIER_MAX_ATTEMPTS = '3';
process.env.SUPPLIER_BACKOFF_BASE_MS = '50';
process.env.OUT_OF_STOCK_RETRY_MS = '250';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5442/shop';
