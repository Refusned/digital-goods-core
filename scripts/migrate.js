import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../src/db.js';
import { config } from '../src/config.js';

const dir = join(config.root, 'db', 'migrations');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  process.stdout.write(`migrate: ${file}\n`);
  await pool.query(readFileSync(join(dir, file), 'utf8'));
}
process.stdout.write('migrate: done\n');
await closePool();
