import { afterAll, describe, expect, it } from 'vitest';
import { PERSONAS, seedDemo } from '../src/demo/seed';
import { MockExecutor } from '../src/executors/mock';
import { ThresholdGuard } from '../src/guard';
import { reconcile } from '../src/reconciliation/report';
import { buildServer } from '../src/server';
import { runNightlyBatch } from '../src/sweeps/batch';
import { addDays } from '../src/time';
import { makeDeps, testPool } from './helpers';

const pool = testPool();
afterAll(() => pool.end());

// Noon WAT on 8 Nov 2026: tonight's window is open and nothing has been swept for today.
const NOW = new Date('2026-11-08T11:00:00Z');

describe('demo seed', () => {
  it('builds genuine history and a live night that exercises every outcome', async () => {
    const base = makeDeps(pool, { now: NOW });
    const seeded = await seedDemo(pool, base.config, NOW);
    expect(seeded.today).toBe('2026-11-08');
    expect(seeded.personas).toHaveLength(PERSONAS.length);

    // History is real: books balance, pots match the ledger, nothing is stuck.
    const yesterday = await reconcile(base, addDays(seeded.today, -1));
    // The test's bank has no memory of the seed's private executor, so only MISSING_DEBIT is expected here;
    // ledger, pot and amount checks must all be clean.
    expect([...new Set(yesterday.flags.map((f) => f.code))]).toEqual(['MISSING_DEBIT']);
    expect(yesterday.totals.executed_sweeps).toBe(PERSONAS.filter((p) => p.historyDays >= 1).length);
    expect((await pool.query("SELECT count(*)::int n FROM sms_outbox WHERE status <> 'SENT'")).rows[0].n).toBe(1); // only the Smart Rate suggestion is live

    // Withdrawal rules show up the way the personas promise.
    const app = buildServer(base);
    const pension = async (key: string) => (await app.inject({ method: 'GET', url: `/api/v1/merchants/${seeded.personas.find((p) => p.key === key)!.merchantId}/pension` })).json();
    expect((await pension('ngozi')).emergency_withdrawal.eligible).toBe(true);
    expect((await pension('chidi')).emergency_withdrawal.reason).toBe('NOT_VESTED');
    expect((await pension('funmi')).emergency_withdrawal.reason).toBe('COOLDOWN_ACTIVE');
    expect((await pension('ngozi')).pin_set).toBe(true);

    // Tonight, live: the same bank balance and guard a demo server would use.
    const live = makeDeps(pool, { now: NOW });
    live.executor = new MockExecutor(500_000_00n);
    live.guard = new ThresholdGuard(1_000_000_00n);
    const r = await runNightlyBatch(live, seeded.today);
    if (r.alreadyRunning) throw new Error('unexpected lock');
    expect(r.summary).toMatchObject({ processed_merchants: 7, successful_sweeps: 4, paused_skipped: 1, buffer_skipped: 1, guard_alerts_held: 1, failed: 0 });
    expect((await reconcile(live, seeded.today)).flags.map((f) => f.code)).toEqual(['HELD_FOR_REVIEW']);
  }, 180_000);
});
