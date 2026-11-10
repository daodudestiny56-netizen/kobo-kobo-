import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { PERSONAS, seedDemo } from '../src/demo/seed';

const config = loadConfig();
const local = /@(localhost|127\.0\.0\.1|db)[:/]/.test(config.databaseUrl);
if (!local && !process.argv.includes('--force')) {
  console.error(`Refusing to wipe ${config.databaseUrl.replace(/:[^:@]*@/, ':***@')}: it is not a local database. Pass --force if you really mean it.`);
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  console.log('Seeding demo data (this replays months of real sweeps, about a minute)...');
  const r = await seedDemo(pool, config);
  console.log(`\nDemo ready for ${r.today}. Tonight's takings are in; nothing has been swept yet.\n`);
  console.table(r.personas.map((p) => ({ name: p.name, phone: p.phone, PIN: p.pin, language: p.language, story: p.story })));
  console.log('Next:\n  npm run dev                                   # start core (set EXECUTOR_MODE=mock, MOCK_DEFAULT_BALANCE_NAIRA=500000, GUARD_HOLD_ABOVE_NAIRA=1000000)');
  console.log('  npm run demo:ussd -- +2348031230001           # dial *384# as Mama Ngozi');
  console.log('  npm run demo:sms  -- +2348031230001 BAL       # text BAL');
  console.log('  npm run demo:sweep                            # run tonight\'s 11 PM sweep now');
  void PERSONAS;
} finally {
  await pool.end();
}
