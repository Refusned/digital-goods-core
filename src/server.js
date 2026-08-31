import { createApp } from './app.js';
import { createSupplierStub } from './suppliers/stub.js';
import { startWorker } from './worker.js';
import { config } from './config.js';
import { log } from './logger.js';

const servers = [];

/** Порт занят это обычная ситуация при локальном запуске, а не повод показывать стек. */
function onListenError(port, what) {
  return (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`Порт ${port} занят (${what}). Освободите его или поменяйте порт в .env\n`);
    } else {
      process.stderr.write(`Не удалось занять порт ${port} (${what}): ${err.message}\n`);
    }
    process.exit(1);
  };
}

const api = createApp().listen(config.port, () => log.info('api.listening', { port: config.port }));
servers.push(api);
api.on('error', onListenError(config.port, 'API'));

// Заглушки поставщиков поднимаются рядом, но как отдельные HTTP-сервисы:
// ядро ходит в них только по сети и ничего не знает про их внутренности.
for (const supplier of [config.suppliers.a, config.suppliers.b]) {
  const stub = createSupplierStub({
    name: supplier.name,
    errorRate: supplier.errorRate,
    timeoutRate: supplier.timeoutRate,
  }).listen(supplier.port, () => log.info('supplier.listening', { supplier: supplier.name, port: supplier.port }));
  stub.on('error', onListenError(supplier.port, `поставщик ${supplier.name}`));
  servers.push(stub);
}

const stopWorker = config.worker.enabled ? startWorker() : null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info('shutdown', { signal });
    if (stopWorker) await stopWorker();
    for (const s of servers) s.close();
    process.exit(0);
  });
}
