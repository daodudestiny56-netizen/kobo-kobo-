import type { Deps } from '../deps';
import { AppError } from '../errors';
import { listActiveMerchants } from '../merchants/service';
import { mapLimit } from '../util/async';
import { sweepCutoff } from '../time';
import { runSweepForMerchant, type Sweep, type SweepStatus } from './engine';
import type { TestOutcome } from '../bank/port';

export interface BatchSummary {
  sweepDate: string;
  merchants: number;
  byStatus: Partial<Record<SweepStatus, number>>;
  errors: number;
  settledKobo: bigint;
}

const running = new Set<string>();

/**
 * Sweep every active merchant for `sweepDate`. Refuses to run before the 23:00 WAT cutoff unless `allowEarly`
 * (demo "run now"), because an early run would lock in partial takings. Safe to run again: the 23:30 job IS the
 * retry, and finished sweeps are returned as they are.
 */
export async function runBatch(
  deps: Deps,
  sweepDate: string,
  o: { allowEarly?: boolean; forceOutcome?: TestOutcome; onlyMerchantId?: string } = {},
): Promise<BatchSummary | { alreadyRunning: true }> {
  if (!o.allowEarly && deps.clock() < sweepCutoff(sweepDate)) {
    throw new AppError('WINDOW_STILL_OPEN', `The sweep window for ${sweepDate} closes at 23:00 WAT. Use allow_early for a demo run.`, 409);
  }
  if (running.has(sweepDate)) return { alreadyRunning: true };
  running.add(sweepDate);
  try {
    const all = listActiveMerchants(deps.db);
    const list = o.onlyMerchantId ? all.filter((m) => m.id === o.onlyMerchantId) : all;
    const out = await mapLimit(list, deps.config.sweep.batchConcurrency, async (m): Promise<Sweep | 'ERROR' | null> => {
      try {
        return await runSweepForMerchant(deps, m.id, sweepDate, { forceOutcome: o.forceOutcome });
      } catch (e) {
        console.error(`[sweep] merchant ${m.id} on ${sweepDate}:`, (e as Error).message);
        return 'ERROR';
      }
    });
    const byStatus: BatchSummary['byStatus'] = {};
    let errors = 0;
    let settledKobo = 0n;
    for (const r of out) {
      if (r === 'ERROR') errors++;
      else if (r) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        if (r.status === 'SETTLED') settledKobo += r.sweep;
      }
    }
    return { sweepDate, merchants: list.length, byStatus, errors, settledKobo };
  } finally {
    running.delete(sweepDate);
  }
}
