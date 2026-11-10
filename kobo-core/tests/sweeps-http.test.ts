import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { addInflow, DAY, DURING, makeDeps, makeMerchant, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool);
  app = buildServer(deps);
});
afterAll(() => pool.end());

const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload });

async function trader(takings: string | null, o: Parameters<typeof makeTrader>[1] = {}) {
  const m = await makeTrader(pool, o);
  if (takings !== null) await addInflow(pool, m.id, takings, DURING);
  deps.executor.setBalance(m.access_nuban, 100_000_000n);
  return m;
}

describe('POST /api/v1/sweeps/execute', () => {
  it('runs one merchant and returns the PRD 6.2 shape', async () => {
    const m = await trader('45000.00');
    const res = await post('/api/v1/sweeps/execute', { merchant_id: m.id, target_date: DAY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      merchant_id: m.id,
      sweep_date: DAY,
      status: 'EXECUTED',
      total_takings: '45000.00',
      sweep_percentage: '2.00',
      sweep_amount: '900.00',
      allocations: { emergency_pot: '450.00', retirement_pot: '450.00' },
      pension_reference: 'PEN-20261106-000001',
      sweep_guard_status: 'CLEARED',
    });
  });

  it('refuses a window that is still open unless allow_early (demo button)', async () => {
    const m = await trader('45000.00');
    deps.setNow(DURING); // 15:00 WAT: 8 hours before the cut-off
    const early = await post('/api/v1/sweeps/execute', { merchant_id: m.id, target_date: DAY });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('WINDOW_STILL_OPEN');
    const demo = await post('/api/v1/sweeps/execute', { merchant_id: m.id, target_date: DAY, allow_early: true });
    expect(demo.statusCode).toBe(200);
    expect(demo.json().status).toBe('EXECUTED');
  });

  it('validates input', async () => {
    expect((await post('/api/v1/sweeps/execute', { merchant_id: 'x', target_date: DAY })).statusCode).toBe(400);
    expect((await post('/api/v1/sweeps/execute', { merchant_id: (await trader(null)).id, target_date: '2026-99-99' })).json().error.code).toBe('INVALID_DATE');
  });
});

describe('POST /api/v1/sweeps/nightly-batch', () => {
  it('runs the batch and answers with the PRD summary', async () => {
    await trader('45000.00');
    await trader(null);
    const res = await post('/api/v1/sweeps/nightly-batch', { target_date: DAY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      execution_date: DAY,
      processed_merchants: 2,
      successful_sweeps: 1,
      zero_sales_skipped: 1,
      total_aum_swept_ngn: '900.00',
    });
  });

  it('defaults to today (WAT) and is guarded while the window is open', async () => {
    deps.setNow(DURING);
    const res = await post('/api/v1/sweeps/nightly-batch', {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WINDOW_STILL_OPEN');
  });
});

describe('Rails-driven flow: split -> (Rails debits) -> settle', () => {
  const settle = (m: { id: string }, o: Record<string, unknown> = {}) =>
    post('/api/v1/sweeps/settle', { merchant_id: m.id, sweep_date: DAY, sweep_amount: '900.00', debit_reference: 'HYD-DEBIT-1', ...o });

  it('settle posts the ledger, credits both pots and queues one SMS receipt', async () => {
    const m = await trader('45000.00');
    const plan = (await post('/api/v1/split', { merchant_id: m.id, sweep_date: DAY, sweep_amount: '900.00' })).json();

    const res = await settle(m);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'EXECUTED',
      already_settled: false,
      sms_receipt: 'QUEUED',
      pension_reference: plan.pension_reference, // the reference Rails got from /split is the one on the receipt
      debit_reference: 'HYD-DEBIT-1',
      allocations: { emergency_pot: '450.00', retirement_pot: '450.00' },
    });
    const pots = (await pool.query('SELECT emergency_balance::text e, retirement_balance::text r FROM pension_accounts WHERE merchant_id=$1', [m.id])).rows[0];
    expect(pots).toEqual({ e: '450.00', r: '450.00' });
    const sms = await pool.query('SELECT body FROM sms_outbox');
    expect(sms.rows).toHaveLength(1);
    expect(sms.rows[0].body).toContain(plan.pension_reference);
  });

  it('is idempotent: a repeat returns already_settled and changes nothing', async () => {
    const m = await trader('45000.00');
    await settle(m);
    const again = await settle(m);
    expect(again.statusCode).toBe(200);
    expect(again.json().already_settled).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM ledger_entries')).rows[0].n).toBe(3);
    expect((await pool.query('SELECT count(*)::int n FROM sms_outbox')).rows[0].n).toBe(1);
  });

  it('409 when a repeat disagrees on the amount', async () => {
    const m = await trader('45000.00');
    await settle(m);
    const res = await settle(m, { sweep_amount: '850.00' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SWEEP_AMOUNT_CONFLICT');
  });

  it('422 when the amount is more than takings x rate (or the cap) allow', async () => {
    const m = await trader('45000.00');
    const res = await settle(m, { sweep_amount: '900.01' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'AMOUNT_EXCEEDS_ALLOWED', details: { allowed: '900.00' } });
    expect((await pool.query('SELECT count(*)::int n FROM ledger_entries')).rows[0].n).toBe(0);
  });

  it('accepts a smaller amount (Rails applied the buffer itself)', async () => {
    const m = await trader('45000.00');
    const res = await settle(m, { sweep_amount: '500.00' });
    expect(res.json()).toMatchObject({ status: 'EXECUTED', sweep_amount: '500.00', allocations: { emergency_pot: '250.00', retirement_pot: '250.00' } });
  });

  it('409 when core already resolved the night differently (e.g. skipped as paused)', async () => {
    const m = await trader('45000.00', { paused: true, pausedUntil: new Date('2026-11-09T00:00:00Z') });
    await post('/api/v1/sweeps/execute', { merchant_id: m.id, target_date: DAY });
    const res = await settle(m);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SWEEP_STATE_CONFLICT', details: { status: 'SKIPPED_PAUSED' } });
  });

  it('then /split refuses the same night with SWEEP_ALREADY_EXECUTED', async () => {
    const m = await trader('45000.00');
    await settle(m);
    const res = await post('/api/v1/split', { merchant_id: m.id, sweep_date: DAY, sweep_amount: '900.00' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SWEEP_ALREADY_EXECUTED');
  });

  it('404 / 422 for unknown merchants and merchants without an RSA', async () => {
    const noRsa = await makeMerchant(pool);
    expect((await settle(noRsa)).json().error.code).toBe('PENSION_ACCOUNT_MISSING');
    expect((await settle({ id: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
  });

  it('two simultaneous settles post exactly one journal', async () => {
    const m = await trader('45000.00');
    const [a, b] = await Promise.all([settle(m), settle(m)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().already_settled, b.json().already_settled].sort()).toEqual([false, true]);
    expect((await pool.query('SELECT count(*)::int n FROM ledger_entries')).rows[0].n).toBe(3);
  });
});
