import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ExecutorError } from '../src/executors/types';
import type { GuardVerdict, SweepGuard } from '../src/guard';
import { ledgerBalances } from '../src/ledger/ledger';
import { dbToKobo } from '../src/money';
import { executeSweepForMerchant, loadSweep } from '../src/sweeps/service';
import { addInflow, DAY, DURING, makeDeps, makeMerchant, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool);
});
afterAll(() => pool.end());

/** A trader with `takings` naira received during DAY's window and `balance` naira in their Access account. */
async function setup(takings: string | null, o: Parameters<typeof makeTrader>[1] & { balance?: bigint } = {}) {
  const m = await makeTrader(pool, o);
  if (takings !== null) await addInflow(pool, m.id, takings, DURING);
  deps.executor.setBalance(m.access_nuban, o.balance ?? 100_000_000n);
  return m;
}

const count = async (table: string, where = 'true') => (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`)).rows[0].n as number;
const pots = async (merchantId: string) => {
  const { rows } = await pool.query('SELECT emergency_balance::text e, retirement_balance::text r FROM pension_accounts WHERE merchant_id=$1', [merchantId]);
  return rows[0] as { e: string; r: string };
};

describe('happy path', () => {
  it('N45,000 at 2% sweeps N900, splits 450/450, posts the ledger and queues the receipt', async () => {
    const m = await setup('30000.00');
    await addInflow(pool, m.id, '15000.00', DURING);

    const rec = await executeSweepForMerchant(deps, m.id, DAY);

    expect(rec).toMatchObject({ status: 'EXECUTED', totalTakings: 4_500_000n, sweepAmount: 90_000n, emergency: 45_000n, retirement: 45_000n });
    expect(rec.pensionReference).toBe('PEN-20261106-000001');
    expect(rec.debitReference).toMatch(/^MOCK-DEBIT-/);
    expect(rec.executedAt).toEqual(NIGHT_DATE());

    expect(await pots(m.id)).toEqual({ e: '450.00', r: '450.00' });
    const l = await ledgerBalances(pool, m.id);
    expect([l.EMERGENCY_POT, l.RETIREMENT_POT, l.MERCHANT_CASH]).toEqual([45_000n, 45_000n, -90_000n]);
    expect(await count('ledger_entries')).toBe(3);

    expect(deps.executor.calls.debit).toBe(1);
    expect([...deps.executor.debits.keys()]).toEqual([`sweep:${m.id}:${DAY}`]);
    expect(deps.executor.balances.get(m.access_nuban)).toBe(100_000_000n - 90_000n);

    const sms = await pool.query('SELECT to_phone, kind, body, status FROM sms_outbox');
    expect(sms.rows).toEqual([
      {
        to_phone: m.phone_number,
        kind: 'SWEEP_RECEIPT',
        status: 'QUEUED',
        body: 'Kobo Kobo: Today sales N45,000. Sweep 2% (N900) sent to Access ARM Pension. Emergency Pot: +N450. Retirement Pot: +N450. Ref: PEN-20261106-000001. Text PAUSE to pause.',
      },
    ]);
  });

  it('starts the 3-month vesting clock on the first contribution', async () => {
    const m = await setup('10000.00');
    await executeSweepForMerchant(deps, m.id, DAY);
    const { rows } = await pool.query('SELECT first_contribution_at FROM pension_accounts WHERE merchant_id=$1', [m.id]);
    expect(rows[0].first_contribution_at).toEqual(NIGHT_DATE());
  });

  it('gives the odd kobo to retirement', async () => {
    const m = await setup('12345.67'); // 2% = 246.9134 -> 246.91 -> 123.45 / 123.46
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.sweepAmount).toBe(24_691n);
    expect([rec.emergency, rec.retirement]).toEqual([12_345n, 12_346n]);
    expect(await pots(m.id)).toEqual({ e: '123.45', r: '123.46' });
  });

  it('writes a pidgin receipt for pidgin traders, and receipts stay plain ASCII', async () => {
    const en = await setup('45000.00');
    const pg = await setup('45000.00', { language: 'pidgin' });
    await executeSweepForMerchant(deps, en.id, DAY);
    await executeSweepForMerchant(deps, pg.id, DAY);
    const { rows } = await pool.query('SELECT merchant_id, body FROM sms_outbox');
    const byMerchant = Object.fromEntries(rows.map((r) => [r.merchant_id, r.body as string]));
    expect(byMerchant[pg.id]).toContain('We don save 2% (N900)');
    for (const body of Object.values<string>(byMerchant)) {
      expect(body).toMatch(/^[\x20-\x7E]+$/); // GSM-friendly, no naira sign
      expect(body.length).toBeLessThanOrEqual(320); // at most two SMS segments
    }
  });
});

function NIGHT_DATE() {
  return deps.clock();
}

describe('the inflow window', () => {
  it('counts [00:00 WAT, 23:00 WAT) of the sweep date and nothing else (PRD v2)', async () => {
    const m = await setup(null);
    const at = (iso: string, amount: string, o = {}) => addInflow(pool, m.id, amount, new Date(iso), o);
    await at('2026-11-05T22:59:59Z', '1000.00'); // 23:59:59 WAT on the 5th -> not the 6th
    await at('2026-11-05T23:00:00Z', '2000.00'); // 00:00:00 WAT on the 6th -> first instant of the window
    await at('2026-11-06T21:59:59Z', '3000.00'); // 22:59:59 WAT on the 6th -> last instant of the window
    await at('2026-11-06T22:00:00Z', '4000.00'); // 23:00:00 WAT on the 6th -> outside the window
    await at('2026-11-06T10:00:00Z', '9000.00', { excluded: true }); // loan disbursement etc.: never counted
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.totalTakings).toBe(500_000n); // 2,000 + 3,000
    expect(rec.sweepAmount).toBe(10_000n);
  });

  it('takings in the 23:00-24:00 hour are in no window (surfaced by reconciliation)', async () => {
    const m = await setup(null);
    await addInflow(pool, m.id, '5000.00', new Date('2026-11-06T22:30:00Z')); // 23:30 WAT on the 6th
    expect((await executeSweepForMerchant(deps, m.id, '2026-11-06')).status).toBe('SKIPPED_ZERO_SALES');
    deps.setNow(new Date('2026-11-07T22:30:00Z'));
    expect((await executeSweepForMerchant(deps, m.id, '2026-11-07')).status).toBe('SKIPPED_ZERO_SALES');
  });
});

describe('skips', () => {
  it('zero sales: N0 sweep, no debit, no ledger, no SMS', async () => {
    const m = await setup(null);
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'SKIPPED_ZERO_SALES', sweepAmount: 0n, pensionReference: null });
    expect(deps.executor.calls.debit).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
    expect(await count('sms_outbox')).toBe(0);
  });

  it('paused with a future paused_until skips; an expired pause does not', async () => {
    const future = await setup('10000.00', { paused: true, pausedUntil: new Date('2026-11-08T10:00:00Z') });
    const expired = await setup('10000.00', { paused: true, pausedUntil: new Date('2026-11-06T10:00:00Z') });
    const indefinite = await setup('10000.00', { paused: true, pausedUntil: null });
    expect((await executeSweepForMerchant(deps, future.id, DAY)).status).toBe('SKIPPED_PAUSED');
    expect((await executeSweepForMerchant(deps, expired.id, DAY)).status).toBe('EXECUTED');
    expect((await executeSweepForMerchant(deps, indefinite.id, DAY)).status).toBe('SKIPPED_PAUSED');
  });

  it('a pause is evaluated at run time: the same merchant sweeps again once it lapses', async () => {
    const m = await setup('10000.00', { paused: true, pausedUntil: new Date('2026-11-07T10:00:00Z') });
    expect((await executeSweepForMerchant(deps, m.id, '2026-11-06')).status).toBe('SKIPPED_PAUSED');
    await addInflow(pool, m.id, '10000.00', new Date('2026-11-07T12:00:00Z'));
    deps.setNow(new Date('2026-11-07T22:30:00Z'));
    expect((await executeSweepForMerchant(deps, m.id, '2026-11-07')).status).toBe('EXECUTED');
  });

  it('a sweep below one kobo is recorded as zero, not debited', async () => {
    const m = await setup('0.40'); // 2% of 40 kobo = 0.8 kobo
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'SKIPPED_ZERO_SALES', failureReason: 'SWEEP_ROUNDS_TO_ZERO' });
    expect(deps.executor.calls.debit).toBe(0);
  });
});

describe('daily cap and working-capital buffer', () => {
  it('caps the sweep at the daily cap', async () => {
    const m = await setup('400000.00', { cap: '5000.00' }); // 2% would be N8,000
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.sweepAmount).toBe(500_000n);
    expect([rec.emergency, rec.retirement]).toEqual([250_000n, 250_000n]);
  });

  it('sweeps only what keeps the buffer: balance N1,500, buffer N1,000 -> N500', async () => {
    const m = await setup('45000.00', { balance: 150_000n }); // wants N900
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'EXECUTED', sweepAmount: 50_000n });
    expect(deps.executor.balances.get(m.access_nuban)).toBe(100_000n); // exactly the buffer is left
  });

  it('skips, alerts and texts when the balance cannot even cover the buffer', async () => {
    const m = await setup('45000.00', { balance: 100_000n });
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.status).toBe('SKIPPED_BUFFER');
    expect(deps.executor.calls.debit).toBe(0);
    expect((await pool.query('SELECT alert_type FROM sweep_guard_alerts')).rows).toEqual([{ alert_type: 'LOW_BUFFER' }]);
    const sms = await pool.query('SELECT kind, body FROM sms_outbox');
    expect(sms.rows[0].kind).toBe('SWEEP_SKIPPED');
    expect(sms.rows[0].body).toContain('N1,000');
  });
});

describe('sweep guard', () => {
  it('a HOLD stops the sweep, raises an alert, texts the trader and is not re-evaluated', async () => {
    let calls = 0;
    const hold: SweepGuard = {
      async evaluate(): Promise<GuardVerdict> {
        calls++;
        return { verdict: 'HOLD', alertType: 'ANOMALOUS_INFLOW', details: { biggest: 10_000_000n, mean: 25_000n } };
      },
    };
    deps.guard = hold;
    const m = await setup('10000000.00');
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'HELD_GUARD', sweepAmount: 0n, failureReason: 'ANOMALOUS_INFLOW' });
    expect(deps.executor.calls.debit).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
    const alert = (await pool.query('SELECT alert_type, status, details FROM sweep_guard_alerts')).rows[0];
    expect(alert).toMatchObject({ alert_type: 'ANOMALOUS_INFLOW', status: 'PENDING_REVIEW' });
    expect(alert.details).toEqual({ biggest: '10000000', mean: '25000' }); // bigint-safe JSON
    expect((await pool.query('SELECT kind FROM sms_outbox')).rows).toEqual([{ kind: 'SWEEP_HELD' }]);

    await executeSweepForMerchant(deps, m.id, DAY);
    expect(calls).toBe(1);
    expect(await count('sweep_guard_alerts')).toBe(1);
  });

  it('hands the guard the inflows and takings it needs', async () => {
    let seen: { takings: bigint; n: number } | null = null;
    deps.guard = {
      async evaluate(ctx) {
        seen = { takings: ctx.takings, n: ctx.inflows.length };
        return { verdict: 'CLEAR' };
      },
    };
    const m = await setup('1000.00');
    await addInflow(pool, m.id, '500.00', DURING);
    await executeSweepForMerchant(deps, m.id, DAY);
    expect(seen).toEqual({ takings: 150_000n, n: 2 });
  });
});

describe('idempotency and concurrency', () => {
  it('a second run changes nothing: one debit, one journal, one SMS', async () => {
    const m = await setup('45000.00');
    const a = await executeSweepForMerchant(deps, m.id, DAY);
    const b = await executeSweepForMerchant(deps, m.id, DAY);
    expect(b).toEqual(a);
    expect(deps.executor.calls.debit).toBe(1);
    expect(await count('ledger_entries')).toBe(3);
    expect(await count('sms_outbox')).toBe(1);
    expect(await pots(m.id)).toEqual({ e: '450.00', r: '450.00' });
  });

  it('ten simultaneous runs still move money exactly once', async () => {
    const m = await setup('45000.00');
    const results = await Promise.all(Array.from({ length: 10 }, () => executeSweepForMerchant(deps, m.id, DAY)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.every((r) => r.status === 'EXECUTED')).toBe(true);
    expect(deps.executor.debits.size).toBe(1);
    expect(deps.executor.balances.get(m.access_nuban)).toBe(100_000_000n - 90_000n);
    expect(await count('ledger_entries')).toBe(3);
    expect(await count('sms_outbox')).toBe(1);
    expect(await pots(m.id)).toEqual({ e: '450.00', r: '450.00' });
  });

  it('a lost debit response (timeout after the money moved) never double-debits', async () => {
    const m = await setup('45000.00');
    deps.executor.failNext('debit', 'TIMEOUT', { afterSuccess: true });
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.status).toBe('EXECUTED');
    expect(rec.attempts).toBe(2); // the retry replayed the same idempotency key
    expect(deps.executor.debits.size).toBe(1);
    expect(deps.executor.balances.get(m.access_nuban)).toBe(100_000_000n - 90_000n);
  });

  it('a crash after the PENDING row is written resumes with the same reference and key', async () => {
    const m = await setup('45000.00', {});
    deps.executor.failNext('debit', 'UNAVAILABLE', { times: 3 }); // first run gives up, leaving PENDING
    const first = await executeSweepForMerchant(deps, m.id, DAY);
    expect(first).toMatchObject({ status: 'PENDING', attempts: 3 });
    expect(first.lastError).toMatch(/UNAVAILABLE/);
    expect(await count('ledger_entries')).toBe(0);

    const second = await executeSweepForMerchant(deps, m.id, DAY); // e.g. the 23:30 retry
    expect(second).toMatchObject({ status: 'EXECUTED', pensionReference: first.pensionReference, attempts: 4 });
    expect(deps.executor.debits.size).toBe(1);
  });
});

describe('failures', () => {
  it('retries that never succeed end as FAILED/RETRIES_EXHAUSTED, with no ledger entries', async () => {
    const m = await setup('45000.00');
    deps.executor.failNext('debit', 'TIMEOUT', { times: 6 });
    expect((await executeSweepForMerchant(deps, m.id, DAY)).status).toBe('PENDING');
    const last = await executeSweepForMerchant(deps, m.id, DAY);
    expect(last).toMatchObject({ status: 'FAILED', failureReason: 'RETRIES_EXHAUSTED', attempts: 6 });
    expect(await count('ledger_entries')).toBe(0);
    expect(await count('sms_outbox')).toBe(0);
    expect(deps.executor.debits.size).toBe(0);
    // terminal: later runs leave it alone
    await executeSweepForMerchant(deps, m.id, DAY);
    expect(deps.executor.calls.debit).toBe(6);
  });

  it('a final bank refusal fails immediately and is not retried', async () => {
    const m = await setup('45000.00');
    deps.executor.failNext('debit', 'ACCOUNT_BLOCKED');
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'FAILED', failureReason: 'ACCOUNT_BLOCKED', attempts: 1 });
    await executeSweepForMerchant(deps, m.id, DAY);
    expect(deps.executor.calls.debit).toBe(1);
    expect(await count('ledger_entries')).toBe(0);
  });

  it('insufficient funds at debit time (balance moved since the check) is a clean FAILED', async () => {
    const m = await setup('45000.00', { balance: 1_000_000n });
    const original = deps.executor.getBalance.bind(deps.executor);
    deps.executor.getBalance = async (n) => {
      const b = await original(n);
      deps.executor.setBalance(n, 0n); // trader spends it all right after we looked
      return b;
    };
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' });
  });

  it('records nothing when the balance lookup is down, so the next run starts clean', async () => {
    const m = await setup('45000.00');
    deps.executor.failNext('balance', 'UNAVAILABLE');
    await expect(executeSweepForMerchant(deps, m.id, DAY)).rejects.toBeInstanceOf(ExecutorError);
    expect(await loadSweep(pool, m.id, DAY)).toBeNull();
    expect((await executeSweepForMerchant(deps, m.id, DAY)).status).toBe('EXECUTED');
  });

  it('refuses to post a ledger that disagrees with what the bank debited', async () => {
    const m = await setup('45000.00');
    deps.executor.debit = async (r) => ({ debitReference: 'BANK-1', amount: r.amount - 1n });
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });
    expect(rec.lastError).toContain('BANK-1');
    expect(await count('ledger_entries')).toBe(0);
  });

  it('refuses a merchant with no RSA and records nothing', async () => {
    const m = await makeMerchant(pool);
    await addInflow(pool, m.id, '1000.00', DURING);
    await expect(executeSweepForMerchant(deps, m.id, DAY)).rejects.toMatchObject({ code: 'PENSION_ACCOUNT_MISSING' });
    expect(await loadSweep(pool, m.id, DAY)).toBeNull();
  });

  it('the pension balance always equals what the ledger says, across nights', async () => {
    const m = await setup('45000.00');
    await executeSweepForMerchant(deps, m.id, DAY);
    await addInflow(pool, m.id, '12345.67', new Date('2026-11-07T12:00:00Z'));
    deps.setNow(new Date('2026-11-07T22:30:00Z'));
    await executeSweepForMerchant(deps, m.id, '2026-11-07');
    const p = await pots(m.id);
    const l = await ledgerBalances(pool, m.id);
    expect(dbToKobo(p.e)).toBe(l.EMERGENCY_POT);
    expect(dbToKobo(p.r)).toBe(l.RETIREMENT_POT);
    expect(l.MERCHANT_CASH).toBe(-(l.EMERGENCY_POT + l.RETIREMENT_POT));
  });
});
