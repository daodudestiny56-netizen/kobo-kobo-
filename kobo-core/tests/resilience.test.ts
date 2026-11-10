import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MockExecutor } from '../src/executors/mock';
import { reconcile } from '../src/reconciliation/report';
import { buildServer } from '../src/server';
import { dispatchDueSms } from '../src/sms/dispatcher';
import { runNightlyBatch } from '../src/sweeps/batch';
import { executeSweepForMerchant } from '../src/sweeps/service';
import { addMonthsToInstant } from '../src/time';
import { addInflow, DAY, DURING, makeDeps, makeTrader, NIGHT, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool);
});
afterAll(() => pool.end());

const count = async (table: string) => (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;

describe('settlement is atomic', () => {
  it('a failure inside settlement leaves no ledger, no pot change and no receipt; the retry completes it with the same debit', async () => {
    const m = await makeTrader(pool);
    await addInflow(pool, m.id, '45000.00', DURING);
    deps.executor.setBalance(m.access_nuban, 100_000_000n);

    // Break the last step of settlement (queueing the receipt) so the transaction must roll back as a whole.
    await pool.query('ALTER TABLE sms_outbox RENAME TO sms_outbox_off');
    try {
      await executeSweepForMerchant(deps, m.id, DAY).catch(() => undefined);
    } finally {
      await pool.query('ALTER TABLE sms_outbox_off RENAME TO sms_outbox');
    }
    expect(await count('ledger_entries')).toBe(0);
    expect((await pool.query('SELECT emergency_balance::text e, retirement_balance::text r, first_contribution_at FROM pension_accounts')).rows[0]).toEqual({ e: '0.00', r: '0.00', first_contribution_at: null });
    expect((await pool.query('SELECT status FROM daily_sweeps')).rows[0].status).toBe('PENDING');
    expect(deps.executor.debits.size).toBe(1); // the bank did debit: that is exactly what the retry must not repeat

    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.status).toBe('EXECUTED');
    expect(deps.executor.debits.size).toBe(1);
    expect(deps.executor.calls.debit).toBe(2); // the replay hit the same idempotency key
    expect(await count('ledger_entries')).toBe(3);
    expect(await count('sms_outbox')).toBe(1);
  });
});

describe('load', () => {
  it('1,500 traders sweep in one batch with unique references, a balanced ledger and pots that match it', async () => {
    const N = 1500;
    await pool.query(
      `INSERT INTO merchants (phone_number, full_name, bvn_hash, access_nuban)
       SELECT '+2347' || lpad(i::text, 9, '0'), 'Load ' || i, 'bvn' || i, (3000000000 + i)::text FROM generate_series(1, $1) i`,
      [N],
    );
    await pool.query(
      `INSERT INTO pension_accounts (merchant_id, rsa_pin) SELECT id, 'PENLOAD' || row_number() OVER (ORDER BY created_at) FROM merchants`,
    );
    await pool.query(
      `INSERT INTO inflow_transactions (merchant_id, bank_reference, amount, channel, settled_at)
       SELECT m.id, 'LOAD-' || m.id || '-' || k, 3000 + (k * 1700), 'POS', $1::timestamptz
         FROM merchants m, generate_series(1, 3) k`,
      [DURING],
    );
    deps.executor = new MockExecutor(100_000_000n);

    const t0 = Date.now();
    const r = await runNightlyBatch(deps, DAY);
    const secs = (Date.now() - t0) / 1000;
    if (r.alreadyRunning) throw new Error('unexpected lock');
    console.log(`[load] ${N} merchants swept in ${secs.toFixed(1)}s (${Math.round(N / secs)}/s)`);

    expect(r.summary).toMatchObject({ processed_merchants: N, successful_sweeps: N, failed: 0, errors: 0, pending_retry: 0 });
    expect(deps.executor.debits.size).toBe(N);
    expect((await pool.query('SELECT count(DISTINCT pension_reference)::int n FROM daily_sweeps')).rows[0].n).toBe(N);
    expect((await pool.query("SELECT sum(CASE entry_type WHEN 'DEBIT' THEN amount ELSE -amount END)::text d FROM ledger_entries")).rows[0].d).toBe('0.00');
    const rec = await reconcile(deps, DAY);
    expect(rec.ok).toBe(true);
    expect(rec.totals.executed_sweeps).toBe(N);
    expect(secs).toBeLessThan(90);

    // And the second run (the 23:30 retry) moves nothing.
    const again = await runNightlyBatch(deps, DAY);
    if (again.alreadyRunning) throw new Error('unexpected lock');
    expect(deps.executor.calls.debit).toBe(N);
  }, 180_000);
});

describe('a full day, end to end', () => {
  it('inflows, the 23:00 sweep, the receipt, USSD and SMS balances, a PIN-protected withdrawal, clean reconciliation', async () => {
    deps.setNow(DURING);
    const app = buildServer(deps);
    const m = await makeTrader(pool, { pin: '7391', pension: { emergency: '0.00', retirement: '0.00', firstContributionAt: addMonthsToInstant(DURING, -4) } });
    deps.executor.setBalance(m.access_nuban, 100_000_000n);
    const ussd = async (text: string) => (await app.inject({ method: 'POST', url: '/api/v1/ussd', payload: { phoneNumber: m.phone_number, text } })).body;
    const sms = async (text: string) => (await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone_number, text } })).json().reply as string;

    // Morning: nothing sold yet.
    expect(await ussd('2')).toMatch(/Takings so far: N0\nSweep tonight \(2%\): N0/);
    // Through the day the trader is paid three times.
    for (const amt of ['12000.00', '18500.00', '14500.00']) await addInflow(pool, m.id, amt, DURING);
    expect(await ussd('2')).toBe('END Takings so far: N45,000\nSweep tonight (2%): N900\nSweeps run at 11pm.');
    expect(await ussd('1')).toContain('Total: N0');

    // 11 PM: the batch runs; the dispatcher delivers the receipt.
    deps.setNow(NIGHT);
    const batch = await runNightlyBatch(deps, DAY);
    if (batch.alreadyRunning) throw new Error('unexpected lock');
    expect(batch.summary).toMatchObject({ successful_sweeps: 1, total_aum_swept_ngn: '900.00' });
    await dispatchDueSms(deps);
    const receipt = deps.sms.sent.find((s) => s.to === m.phone_number && s.body.includes('PEN-20261106-'));
    expect(receipt?.body).toMatch(/N900/);

    // Every channel agrees on the new balance: N900, split 450 / 450.
    expect(await ussd('1')).toBe('CON Kobo Kobo Balance\nTotal: N900\nEmergency: N450 (Eligible)\nRetirement: N450 (Locked to 50)\n0. Back');
    expect(await sms('BAL')).toContain('Total saved is N900');
    expect((await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/pension` })).json()).toMatchObject({ emergency_pot: '450.00', retirement_pot: '450.00' });

    // The trader cashes out N200: wrong PIN first, then the right one.
    expect(await ussd('5*200*1*0000')).toMatch(/^END Wrong PIN\. 2 tries left/);
    expect(deps.executor.calls.credit).toBe(0);
    expect(await ussd('5*200*1*7391')).toMatch(/^END N200 is on its way/);
    await dispatchDueSms(deps);
    expect(deps.sms.sent.some((s) => s.to === m.phone_number && s.body.includes('N200'))).toBe(true);
    expect(await ussd('1')).toContain('Emergency: N250');
    expect(await ussd('5*100*1*7391')).toMatch(/^END Emergency cashout unavailable: Next payout/); // 60-day cooldown now applies

    // The books close clean and every text reached the provider.
    const rec = await reconcile(deps, DAY);
    expect(rec).toMatchObject({ ok: true, totals: { executed_sweeps: 1, swept_per_core: '900.00', debited_per_bank: '900.00' } });
    expect(await count('sms_outbox')).toBe((await pool.query("SELECT count(*)::int n FROM sms_outbox WHERE status = 'SENT'")).rows[0].n);
    await app.close();
  });
});
