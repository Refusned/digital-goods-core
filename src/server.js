import { createApp } from './app.js';
import { createSupplierStub } from './suppliers/stub.js';
import { startWorker } from './worker.js';
import { config } from './config.js';
import { log } from './logger.js';

const servers = [];

const api = createApp().listen(config.port, () => log.info('api.listening', { port: config.port }));
servers.push(api);

// Заглушки поставщиков поднимаются рядом, но как отдельные HTTP-сервисы:
// ядро ходит в них только по сети и ничего не знает про их внутренности.
for (const supplier of [config.suppliers.a, config.suppliers.b]) {
  const stub = createSupplierStub({
    name: supplier.name,
    errorRate: supplier.errorRate,
    timeoutRate: supplier.timeoutRate,
  }).listen(supplier.port, () => log.info('supplier.listening', { supplier: supplier.name, port: supplier.port }));
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
