import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { SimulatedBank } from '../src/bank/simulated';
import { AllowAllGuard } from '../src/guard/port';
import { seedDemo } from '../src/demo/seed';

const config = loadConfig();
if (config.nodeEnv === 'production' && !config.demoMode) throw new Error('Refusing to seed a non-demo production database.');
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
const clock = () => new Date();
const deps = { db: openDb(config.dbPath), config, clock, bank: new SimulatedBank(clock), guard: new AllowAllGuard() };
const r = await seedDemo(deps);
console.log(`Seeded ${r.personas.length} demo traders for ${r.today} (synthetic data):`);
for (const p of r.personas) console.log(`  ${p.name.padEnd(16)} ${p.phone}  ${p.story}`);
