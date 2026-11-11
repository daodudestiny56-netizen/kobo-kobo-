import { describe, expect, it } from 'vitest';
import { seedDemo, PERSONAS } from '../src/demo/seed';
import { ledgerProblems } from '../src/ledger/ledger';
import { reconciliationReport } from '../src/reconciliation/report';
import { merchantSummary } from '../src/merchants/summary';
import { runBatch } from '../src/sweeps/batch';
import { ThresholdGuard } from '../src/guard/port';
import { makeDeps } from './helpers';
import { toWatDate } from '../src/time';

describe('demo seed', () => {
  it('builds eight traders with clean books, the right stories and an unswept night', async () => {
    const now = new Date('2026-11-12T14:00:00Z');
    const deps = makeDeps({ now });
    deps.guard = new ThresholdGuard(1_000_000_00n);
    const r = await seedDemo(deps, now);
    expect(r.personas).toHaveLength(PERSONAS.length);
    expect(ledgerProblems(deps.db)).toEqual([]);
    expect((await reconciliationReport(deps)).ok).toBe(true);

    const by = Object.fromEntries(r.personas.map((p) => [p.key, merchantSummary(deps, p.merchantId)]));
    expect(by.adaeze.eligibility.eligible).toBe(true); // vested, no past withdrawal
    expect(by.efosa.eligibility.eligible).toBe(false); // under a month old
    expect(by.babatunde.eligibility.eligible).toBe(true);
    expect(by.musa.eligibility.eligible).toBe(false); // 8 weeks in
    expect(by.funmi.eligibility.eligible).toBe(false); // cooldown after the 20-day-old withdrawal
    expect(by.bisi.paused).toBe(true);
    expect(by.babatunde.takingsToday).toBe(2_300_000n); // N23,000 tonight
    expect(deps.db.prepare(`SELECT COUNT(*) n FROM rate_suggestions WHERE status = 'OPEN'`).get()).toEqual({ n: 1 });

    // Live night: Bisi paused, Emeka under his buffer, Ife's big credit held (her smaller one still sweeps).
    const run = await runBatch(deps, toWatDate(now), { allowEarly: true });
    expect('byStatus' in run && run.byStatus).toMatchObject({ SETTLED: 6, SKIPPED_PAUSED: 1, SKIPPED_LOW_BALANCE: 1 });
    expect(deps.db.prepare(`SELECT COUNT(*) n FROM guard_alerts WHERE status = 'PENDING_REVIEW'`).get()).toEqual({ n: 1 });
    expect(ledgerProblems(deps.db)).toEqual([]);
  }, 60_000);

  it('can be reset and re-seeded with identical history', async () => {
    const now = new Date('2026-11-12T14:00:00Z');
    const deps = makeDeps({ now });
    await seedDemo(deps, now);
    const count = () => deps.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get();
    const first = count();
    await seedDemo(deps, now);
    expect(count()).toEqual(first);
  }, 60_000);
});
