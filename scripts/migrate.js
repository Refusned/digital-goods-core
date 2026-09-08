/**
 * Накатывание миграций.
 *
 * Каждый файл применяется РОВНО ОДИН РАЗ и запоминается в schema_migrations.
 * Повторный прогон уже применённой миграции это не безобидная операция: миграция может
 * снимать ограничение, которое ставила предыдущая, и её повтор на живых данных упадёт.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../src/db.js';
import { config } from '../src/config.js';
import { applyMigrations } from './lib/migrations.js';

const applied = await applyMigrations(pool, join(config.root, 'db', 'migrations'), (line) => process.stdout.write(line));
process.stdout.write(`migrate: done (${applied} новых)\n`);
await closePool();
