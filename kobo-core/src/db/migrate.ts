import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withTx, type Pool } from './pool';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Apply every `migrations/NNN_*.sql` not yet recorded in kobo_core_migrations, in filename order.
 * Each file runs inside one transaction together with its bookkeeping row. Files may carry their own
 * BEGIN;/COMMIT; lines (001 does); they are stripped so the runner's transaction is the only one.
 */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  // One migrator at a time, so several containers booting together cannot apply the same file twice.
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(727001)');
    return await applyPending(pool, dir);
  } finally {
    await lock.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    lock.release();
  }
}

async function applyPending(pool: Pool, dir: string): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS kobo_core_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
  const applied = new Set((await pool.query<{ filename: string }>('SELECT filename FROM kobo_core_migrations')).rows.map((r) => r.filename));
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = (await readFile(`${dir}${file}`, 'utf8')).replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '');
    await withTx(pool, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO kobo_core_migrations (filename) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
