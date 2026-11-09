import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, productionProblems } from './config';
import { openDb } from './db';
import { buildServer } from './server';
import { SimulatedBank } from './bank/simulated';
import { AllowAllGuard } from './guard/port';
import { startScheduler } from './sweeps/scheduler';

const config = loadConfig();
const problems = productionProblems(config);
if (problems.length) {
  for (const p of problems) console.error(`[boot] ${p}`);
  process.exit(1);
}
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

const db = openDb(config.dbPath);
// Until the real Xtradot client lands, run against the in-memory simulated bank (same trigger amounts as the sandbox).
const clock = () => new Date();
const deps = { db, config, clock, bank: new SimulatedBank(clock), guard: new AllowAllGuard() };
console.warn('[boot] bank = SimulatedBank (no real bank calls)');
const app = buildServer(deps);

process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandled rejection', e);
  process.exit(1);
});

startScheduler(deps);
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`[boot] kobo server listening on :${config.port}`);
