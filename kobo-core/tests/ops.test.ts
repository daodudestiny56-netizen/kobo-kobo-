import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { buildServer } from '../src/server';
import { makeDeps, testPool } from './helpers';

const pool = testPool();
afterAll(() => pool.end());

describe('health', () => {
  it('is ok with a working database and 503 without one', async () => {
    const ok = buildServer(makeDeps(pool));
    expect((await ok.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    await ok.close();

    const broken = makeDeps(pool);
    broken.db = { ...broken.db, query: async () => { throw new Error('connection refused'); } } as never;
    const app = buildServer(broken);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', reason: 'database' });
    await app.close();
  });
});

describe('migrations on a fresh database', () => {
  it('several instances booting at once apply every file exactly once, and a rerun does nothing', async () => {
    const name = `kobo_mig_${Date.now()}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const fresh = createPool(url.toString());
    try {
      const results = await Promise.all([migrate(fresh), migrate(fresh), migrate(fresh)]);
      const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
      expect(results.flat().sort()).toEqual(files); // each file applied by exactly one instance
      expect(await migrate(fresh)).toEqual([]);
      expect((await fresh.query('SELECT count(*)::int n FROM kobo_core_migrations')).rows[0].n).toBe(files.length);
      // Rails' own bookkeeping table name is untouched
      expect((await fresh.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t).toBeNull();
    } finally {
      await fresh.end();
      await pool.query(`DROP DATABASE ${name}`);
    }
  });
});
