import pg from 'pg';
import { migrate } from '../src/db/migrate';

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/kobo_test';

/** Create a fresh test database and apply all migrations once per test run. */
export default async function setup() {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1);
  if (!/^\w+$/.test(dbName)) throw new Error(`Unsafe test database name: ${dbName}`);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to drop "${dbName}": test database names must end in _test`);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST_URL });
  await migrate(pool);
  await pool.end();
}
