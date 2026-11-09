import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, productionProblems } from './config';
import { openDb } from './db';
import { buildServer } from './server';

const config = loadConfig();
const problems = productionProblems(config);
if (problems.length) {
  for (const p of problems) console.error(`[boot] ${p}`);
  process.exit(1);
}
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

const db = openDb(config.dbPath);
const deps = { db, config, clock: () => new Date() };
const app = buildServer(deps);

process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandled rejection', e);
  process.exit(1);
});

await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`[boot] kobo server listening on :${config.port}`);
