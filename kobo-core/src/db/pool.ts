import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Anything with `.query` (a Pool or a checked-out client inside a transaction). */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 20 });
  pool.on('error', (e) => console.error('[pg] idle client error', e));
  return pool;
}

/** Run `fn` in a transaction; COMMIT on success, ROLLBACK on any throw. */
export async function withTx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* connection already broken; surface the original error */
    }
    throw e;
  } finally {
    c.release();
  }
}
