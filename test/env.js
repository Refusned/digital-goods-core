/**
 * Страж тестового окружения. Импортируется первым в каждом тестовом файле.
 *
 * Подготовку базы делает scripts/test.js ДО запуска процесса тестов, потому что подменить
 * DATABASE_URL "перед импортами" внутри самого файла нельзя: статические импорты ESM
 * выполняются раньше, чем завершается top-level await соседнего модуля.
 *
 * Здесь остаётся только проверка fail closed: тесты очищают таблицы, поэтому они обязаны
 * работать на выделенной базе и обязаны падать, если это не так.
 */
const url = process.env.DATABASE_URL || '';
const dbName = (() => {
  try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; }
})();

const allowed = process.env.ALLOW_DESTRUCTIVE_TESTS === '1' && dbName.endsWith('_test');
if (!allowed) {
  throw new Error(
    `Тесты чистят таблицы и запускаются только на выделенной базе.\n` +
    `Запускайте их через "npm test" (он сам создаст и мигрирует базу <имя>_test).\n` +
    `Сейчас DATABASE_URL указывает на базу "${dbName || 'не задана'}".`,
  );
}

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

// Настройки поведения задаются ЖЁСТКО, а не берутся из .env: иначе тест зависит от того,
// что лежит в окружении конкретного разработчика, и у проверяющего падает то, что работает.
process.env.WORKER_ENABLED = '0';                  // воркер тесты поднимают точечно
process.env.SUPPLIER_TIMEOUT_MS = '400';
process.env.SUPPLIER_MAX_ATTEMPTS = '3';
process.env.SUPPLIER_BACKOFF_BASE_MS = '50';
process.env.OUT_OF_STOCK_RETRY_MS = '250';
process.env.DELIVERY_DEADLINE_MS = '120000';
process.env.DELIVERY_MAX_ITEM_ATTEMPTS = '8';
process.env.DELIVERY_MAX_CODE_REJECTIONS = '3';
process.env.REFUND_RETRY_MS = '300';
// Лимит поставщика по умолчанию тестам не мешает: сценарии, которым он нужен,
// выставляют свой через /admin/suppliers/:name/rate-limit.
process.env.SUPPLIER_RATE_CAPACITY = '1000';
process.env.SUPPLIER_RATE_WINDOW_MS = '60000';
// Фоновая сверка с поставщиком по умолчанию выключена: она делает ту же работу, что и
// ручной прогон /admin/audit/run, но в непредсказуемый момент, и сценарии наблюдали бы
// не своё состояние, а результат чужого фонового прохода. Тест, которому нужен именно фон,
// включает её сам.
process.env.SUPPLIER_RECONCILER_ENABLED = '0';
