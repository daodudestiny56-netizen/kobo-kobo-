import { describe, expect, it } from 'vitest';
import { StatisticalGuard } from '../src/guard/statistical';
import { ThresholdGuard } from '../src/guard/port';
import { getMerchant } from '../src/merchants/service';
import { analyzeMerchant, runSmartRate } from '../src/smart-rate/analyze';
import { runBatch } from '../src/sweeps/batch';
import { getSweep, windowInflows } from '../src/sweeps/engine';
import { listAlerts } from '../src/sweeps/alerts';
import { addDays } from '../src/time';
import { addInflow, AFTER_CUTOFF, DATE, fundedMerchant, makeDeps, T0 } from './helpers';

const NAIRA = (n: number) => BigInt(Math.round(n)) * 100n;
const midday = new Date('2026-11-13T11:00:00Z');

function setup() {
  const deps = makeDeps({ now: AFTER_CUTOFF });
  deps.guard = new StatisticalGuard(deps.db);
  const m = fundedMerchant(deps);
  return { deps, m };
}

/** `days` days of steady sales ending on `lastDay`, one credit a day at 11:00Z. */
function steadyHistory(deps: ReturnType<typeof makeDeps>, merchantId: string, days: number, level: number, lastDay = DATE) {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    addInflow(deps.db, merchantId, NAIRA(level * (1 + 0.04 * Math.sin(i))), new Date(`${day}T11:00:00Z`));
  }
}

describe('StatisticalGuard', () => {
  it('lets ordinary sales through', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(10_000), midday);
    const flags = await deps.guard.evaluate({ merchantId: m.id, sweepDate: DATE, inflows: windowInflows(deps.db, m.id, DATE).inflows });
    expect(flags).toEqual([]);
  });

  it('flags a huge credit and leaves the others alone', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(10_000), midday);
    const big = addInflow(deps.db, m.id, NAIRA(3_000_000), midday, 'BIG-1');
    const flags = await deps.guard.evaluate({ merchantId: m.id, sweepDate: DATE, inflows: windowInflows(deps.db, m.id, DATE).inflows });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ inflowId: big, type: 'ANOMALY' });
    expect(String(flags[0].details.reason)).toContain('3,000,000');
  });

  it('uses the trader\'s own history: 300,000 is normal for a trader who takes 280,000 a day', async () => {
    const { deps, m } = setup();
    for (let i = 1; i <= 12; i++) for (let k = 0; k < 3; k++) addInflow(deps.db, m.id, NAIRA(280_000), new Date(`${addDays(DATE, -i)}T1${k}:00:00Z`));
    addInflow(deps.db, m.id, NAIRA(600_000), midday);
    const flags = await deps.guard.evaluate({ merchantId: m.id, sweepDate: DATE, inflows: windowInflows(deps.db, m.id, DATE).inflows });
    expect(flags).toEqual([]);
  });

  it('does not let a held credit poison the baseline', async () => {
    const { deps, m } = setup();
    const old = addInflow(deps.db, m.id, NAIRA(5_000_000), new Date(`${addDays(DATE, -2)}T11:00:00Z`));
    deps.db.prepare(`UPDATE inflows SET hold_status = 'HELD' WHERE id = ?`).run(old);
    addInflow(deps.db, m.id, NAIRA(5_000_000), midday, 'BIG-2');
    const flags = await deps.guard.evaluate({ merchantId: m.id, sweepDate: DATE, inflows: windowInflows(deps.db, m.id, DATE).inflows });
    expect(flags).toHaveLength(1);
  });

  it('can run a fixed ceiling alongside the statistics without flagging a credit twice', async () => {
    const { deps, m } = setup();
    const guard = new StatisticalGuard(deps.db, new ThresholdGuard(NAIRA(100_000)));
    addInflow(deps.db, m.id, NAIRA(3_000_000), midday);
    addInflow(deps.db, m.id, NAIRA(150_000), midday);
    const flags = await guard.evaluate({ merchantId: m.id, sweepDate: DATE, inflows: windowInflows(deps.db, m.id, DATE).inflows });
    expect(flags).toHaveLength(2);
    expect(new Set(flags.map((f) => f.inflowId)).size).toBe(2);
  });

  it('in a real sweep: holds the huge credit, raises one alert and still sweeps the rest', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(10_000), midday);
    addInflow(deps.db, m.id, NAIRA(3_000_000), midday, 'BIG-3');
    await runBatch(deps, DATE);
    const sweep = getSweep(deps.db, m.id, DATE)!;
    expect(sweep.status).toBe('SETTLED');
    expect(sweep.takings).toBe(NAIRA(10_000));
    expect(sweep.sweep).toBe(NAIRA(200)); // 2% of the 10,000 that was not held
    const alerts = listAlerts(deps.db, 'PENDING_REVIEW');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('ANOMALY');
  });
});

describe('SmartRate runner', () => {
  it('files a suggestion for a steady trader, and only one while it is waiting', () => {
    const { deps, m } = setup();
    steadyHistory(deps, m.id, 40, 80_000);
    const run = analyzeMerchant(deps, m.id);
    expect(run.result.action).toBe('INCREASE');
    expect(run.suggestionId).toBeTruthy();
    const row = deps.db.prepare('SELECT suggested_bps, current_bps, reason FROM rate_suggestions WHERE merchant_id = ?').get(m.id) as { suggested_bps: number; current_bps: number; reason: string };
    expect(row).toMatchObject({ current_bps: 200, suggested_bps: 250 });
    expect(row.reason.length).toBeLessThanOrEqual(500);
    expect(getMerchant(deps.db, m.id).rateBps).toBe(200); // never changes on its own

    const again = analyzeMerchant(deps, m.id);
    expect(again.suggestionId).toBeNull();
    expect(again.result.holdReason).toBe('COOLDOWN'); // the open suggestion is respected
  });

  it('does not file anything for a new trader with no history', () => {
    const { deps, m } = setup();
    const run = analyzeMerchant(deps, m.id);
    expect(run.result).toMatchObject({ action: 'HOLD', holdReason: 'INSUFFICIENT_DATA' });
    expect(run.suggestionId).toBeNull();
    expect(deps.db.prepare('SELECT COUNT(*) c FROM rate_suggestions').get()).toEqual({ c: 0 });
  });

  it('can analyse without filing', () => {
    const { deps, m } = setup();
    steadyHistory(deps, m.id, 40, 80_000);
    const run = analyzeMerchant(deps, m.id, { file: false });
    expect(run.result.action).toBe('INCREASE');
    expect(run.suggestionId).toBeNull();
    expect(deps.db.prepare('SELECT COUNT(*) c FROM rate_suggestions').get()).toEqual({ c: 0 });
  });

  it('holds for a paused trader', () => {
    const { deps, m } = setup();
    steadyHistory(deps, m.id, 40, 80_000);
    deps.db.prepare(`UPDATE merchants SET paused_until = ? WHERE id = ?`).run(new Date(T0.getTime() + 7 * 86_400_000).toISOString(), m.id);
    expect(analyzeMerchant(deps, m.id).result.holdReason).toBe('PAUSED');
  });

  it('runs for every trader and one failing trader does not stop the rest', () => {
    const { deps, m } = setup();
    steadyHistory(deps, m.id, 40, 80_000);
    const other = fundedMerchant(deps);
    const runs = runSmartRate(deps);
    expect(runs.map((r) => r.merchantId).sort()).toEqual([m.id, other.id].sort());
    expect(runs.filter((r) => r.suggestionId)).toHaveLength(1);
  });
});
