import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { reconcile } from '../src/reconciliation/report';
import { executeSweepForMerchant } from '../src/sweeps/service';
import { addInflow, DAY, DURING, makeDeps, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool);
});
afterAll(() => pool.end());

async function sweptTrader(takings: string) {
  const m = await makeTrader(pool);
  await addInflow(pool, m.id, takings, DURING);
  deps.executor.setBalance(m.access_nuban, 100_000_000n);
  await executeSweepForMerchant(deps, m.id, DAY);
  return m;
}
const codes = async () => (await reconcile(deps, DAY)).flags.map((f) => f.code).sort();

describe('reconciliation', () => {
  it('a clean night balances: core, bank and ledger agree', async () => {
    await sweptTrader('45000.00');
    await sweptTrader('20000.00');
    const r = await reconcile(deps, DAY);
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual({
      merchants_with_sweep: 2,
      executed_sweeps: 2,
      total_takings: '65000.00',
      swept_per_core: '1300.00',
      debited_per_bank: '1300.00',
      credited_to_pots_per_ledger: '1300.00',
      difference_core_vs_bank: '0.00',
    });
  });

  it('reports takings from the unswept 23:00-24:00 hour as a note, not a failure', async () => {
    const m = await sweptTrader('45000.00');
    await addInflow(pool, m.id, '1500.00', new Date('2026-11-06T22:30:00Z'));
    const r = await reconcile(deps, DAY);
    expect(r.ok).toBe(true);
    expect(r.unswept_late_inflows).toEqual({ count: 1, total: '1500.00' });
  });

  it('flags a sweep the bank has no debit for', async () => {
    await sweptTrader('45000.00');
    deps.executor.debits.clear();
    expect(await codes()).toEqual(['MISSING_DEBIT']);
  });

  it('flags a bank debit with a different amount', async () => {
    await sweptTrader('45000.00');
    for (const d of deps.executor.debits.values()) d.amount += 100n;
    expect(await codes()).toEqual(['AMOUNT_MISMATCH']);
  });

  it('flags a bank debit that core has no sweep for', async () => {
    const m = await makeTrader(pool);
    deps.executor.setBalance(m.access_nuban, 1_000_000n);
    await deps.executor.debit({ idempotencyKey: `sweep:${m.id}:${DAY}`, merchantId: m.id, nuban: m.access_nuban, amount: 50_000n, narration: 'x', pensionReference: 'PEN-X' });
    expect(await codes()).toEqual(['ORPHAN_DEBIT']);
  });

  it('flags pots that drift from the ledger, and pending withdrawals', async () => {
    const m = await sweptTrader('45000.00');
    await pool.query(`UPDATE pension_accounts SET retirement_balance = retirement_balance + 1 WHERE merchant_id = $1`, [m.id]);
    expect(await codes()).toEqual(['POT_DRIFT']);
  });

  it('reports a sweep left PENDING and a failed one', async () => {
    const a = await makeTrader(pool);
    const b = await makeTrader(pool);
    for (const m of [a, b]) {
      await addInflow(pool, m.id, '45000.00', DURING);
      deps.executor.setBalance(m.access_nuban, 100_000_000n);
    }
    deps.executor.failNext('debit', 'UNAVAILABLE', { times: 3 });
    await executeSweepForMerchant(deps, a.id, DAY);
    deps.executor.failNext('debit', 'ACCOUNT_BLOCKED');
    await executeSweepForMerchant(deps, b.id, DAY);
    expect(await codes()).toEqual(['FAILED_SWEEP', 'STUCK_SWEEP']);
  });

  it('is served at GET /api/v1/reconciliation', async () => {
    await sweptTrader('45000.00');
    const app = buildServer(deps);
    const res = await app.inject({ method: 'GET', url: `/api/v1/reconciliation?date=${DAY}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sweep_date: DAY, ok: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/reconciliation?date=nope' })).statusCode).toBe(400);
    await app.close();
  });
});
