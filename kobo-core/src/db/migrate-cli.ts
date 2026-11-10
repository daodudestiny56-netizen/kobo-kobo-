import { loadConfig } from '../config';
import { createPool } from './pool';
import { migrate } from './migrate';

const pool = createPool(loadConfig().databaseUrl);
try {
  const ran = await migrate(pool);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
} finally {
  await pool.end();
}
