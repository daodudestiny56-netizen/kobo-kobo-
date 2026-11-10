import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { GuardVerdict } from '../src/guard';
import { runNightlyBatch } from '../src/sweeps/batch';
import { startScheduler } from '../src/sweeps/scheduler';
import { addInflow, DAY, DURING, makeDeps, makeMerchant, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool);
});
afterAll(() => pool.end());

async function trader(takings: string | null, o: Parameters<typeof makeTrader>[1] & { balance?: bigint } = {}) {
  const m = await makeTrader(pool, o);
  if (takings !== null) await addInflow(pool, m.id, takings, DURING);
  deps.executor.setBalance(m.access_nuban, o.balance ?? 100_000_000n);
  return m;
}

const run = async () => {
  const r = await runNightlyBatch(deps, DAY);
  if (r.alreadyRunning) throw new Error('unexpected lock');
  return r.summary;
};

describe('nightly batch', () => {
  it('sorts a mixed night into the PRD summary buckets', async () => {
    await trader('45000.00'); // executes: N900
    await trader('20000.00'); // executes: N400
    await trader(null); // zero sales
    await trader('10000.00', { paused: true, pausedUntil: new Date('2026-11-09T00:00:00Z') });
    await trader('10000.00', { balance: 100_000n }); // buffer
    const held = await trader('5000000.00');
    const refused = await trader('10000.00'); // the bank will refuse this one for good
    await makeMerchant(pool); // no RSA yet: not part of the night

    deps.guard = {
      async evaluate(ctx): Promise<GuardVerdict> {
        return ctx.merchantId === held.id ? { verdict: 'HOLD', alertType: 'ANOMALOUS_INFLOW', details: {} } : { verdict: 'CLEAR' };
      },
    };
    const realDebit = deps.executor.debit.bind(deps.executor);
    deps.executor.debit = async (r) => {
      if (r.merchantId === refused.id) deps.executor.failNext('debit', 'ACCOUNT_BLOCKED');
      return realDebit(r);
    };

    const s = await run();
    expect(s).toEqual({
      execution_date: DAY,
      processed_merchants: 7,
      successful_sweeps: 2,
      zero_sales_skipped: 1,
      paused_skipped: 1,
      buffer_skipped: 1,
      guard_alerts_held: 1,
      failed: 1,
      pending_retry: 0,
      errors: 0,
      total_aum_swept_ngn: '1300.00',
    });
  });

  it('is safe to run twice: the second run moves nothing and reports the same night', async () => {
    await trader('45000.00');
    await trader('20000.00');
    const first = await run();
    const calls = deps.executor.calls.debit;
    const second = await run();
    expect(second).toEqual(first);
    expect(deps.executor.calls.debit).toBe(calls);
    expect((await pool.query('SELECT count(*)::int n FROM ledger_entries')).rows[0].n).toBe(6);
    expect((await pool.query('SELECT count(*)::int n FROM sms_outbox')).rows[0].n).toBe(2);
  });

  it('the 23:30 re-run is the retry: a merchant left PENDING completes on the second pass', async () => {
    await trader('45000.00');
    deps.executor.failNext('debit', 'UNAVAILABLE', { times: 3 }); // exhausts this run's tries
    const first = await run();
    expect(first).toMatchObject({ pending_retry: 1, successful_sweeps: 0 });
    const second = await run();
    expect(second).toMatchObject({ pending_retry: 0, successful_sweeps: 1, total_aum_swept_ngn: '900.00' });
    expect(deps.executor.debits.size).toBe(1);
  });

  it('one merchant erroring does not stop the others, and is picked up next run', async () => {
    const flaky = await trader('45000.00');
    await trader('20000.00');
    const realBalance = deps.executor.getBalance.bind(deps.executor);
    let failedOnce = false;
    deps.executor.getBalance = async (nuban) => {
      if (nuban === flaky.access_nuban && !failedOnce) {
        failedOnce = true;
        throw new (await import('../src/executors/types')).ExecutorError('UNAVAILABLE', 'balance API down');
      }
      return realBalance(nuban);
    };
    const first = await run();
    expect(first).toMatchObject({ errors: 1, successful_sweeps: 1 });
    const second = await run();
    expect(second).toMatchObject({ errors: 0, successful_sweeps: 2, total_aum_swept_ngn: '1300.00' });
  });

  it('handles a few dozen merchants in parallel with unique references and a balanced ledger', async () => {
    const traders = [];
    for (let i = 0; i < 30; i++) traders.push(await trader(`${10000 + i * 1000}.00`));
    const s = await run();
    expect(s.successful_sweeps).toBe(30);
    expect(deps.executor.debits.size).toBe(30);
    const refs = await pool.query('SELECT pension_reference FROM daily_sweeps');
    expect(new Set(refs.rows.map((r) => r.pension_reference)).size).toBe(30);
    const sums = await pool.query(
      `SELECT sum(CASE WHEN entry_type='DEBIT' THEN amount ELSE -amount END)::text AS imbalance FROM ledger_entries`,
    );
    expect(sums.rows[0].imbalance).toBe('0.00');
    // every pot matches the ledger
    const drift = await pool.query(
      `SELECT count(*)::int n FROM pension_accounts p WHERE p.emergency_balance <>
         COALESCE((SELECT sum(amount) FROM ledger_entries l WHERE l.merchant_id = p.merchant_id AND account_type='EMERGENCY_POT' AND entry_type='CREDIT'),0)`,
    );
    expect(drift.rows[0].n).toBe(0);
    void traders;
  });

  it('only one batch per date runs at a time (advisory lock)', async () => {
    await trader('45000.00');
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`kobo:nightly-batch:${DAY}`]);
    expect(await runNightlyBatch(deps, DAY)).toEqual({ alreadyRunning: true });
    expect(deps.executor.calls.debit).toBe(0);
    await holder.end(); // session ends, lock released
    const r = await runNightlyBatch(deps, DAY);
    expect(r.alreadyRunning).toBe(false);
  });

  it('two simultaneous batches never double-sweep', async () => {
    for (let i = 0; i < 5; i++) await trader('45000.00');
    const [a, b] = await Promise.all([runNightlyBatch(deps, DAY), runNightlyBatch(deps, DAY)]);
    expect([a, b].some((r) => !r.alreadyRunning)).toBe(true);
    expect(deps.executor.debits.size).toBe(5);
    expect((await pool.query('SELECT count(*)::int n FROM ledger_entries')).rows[0].n).toBe(15);
  });
});

describe('scheduler', () => {
  it('starts and stops, and rejects a bad cron expression', () => {
    const s = startScheduler(deps);
    s.stop();
    expect(() => startScheduler({ ...deps, config: { ...deps.config, scheduler: { ...deps.config.scheduler, sweepCron: 'not a cron' } } })).toThrow(/Invalid cron/);
  });
});
