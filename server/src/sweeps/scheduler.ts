import cron from 'node-cron';
import type { Deps } from '../deps';
import { toWatDate } from '../time';
import { runBatch } from './batch';
import { requeryDue } from './engine';

/**
 * 23:00 WAT sweep, 23:30 re-run (it IS the retry for anything that did not finish), and a requery loop every
 * minute for transfers that are pending, unknown or recently settled (late reversals).
 */
export function startScheduler(deps: Deps): () => void {
  const c = deps.config.scheduler;
  if (!c.enabled) return () => {};
  const tz = { timezone: 'Africa/Lagos' };
  const sweep = async () => {
    const date = toWatDate(deps.clock());
    try {
      const r = await runBatch(deps, date);
      console.log(`[scheduler] sweep ${date}:`, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      console.error('[scheduler] sweep failed:', (e as Error).message);
    }
  };
  const jobs = [
    cron.schedule(c.sweepCron, sweep, tz),
    cron.schedule(c.retryCron, sweep, tz),
    cron.schedule(c.requeryCron, () => void requeryDue(deps).catch((e) => console.error('[scheduler] requery failed:', (e as Error).message))),
  ];
  return () => jobs.forEach((j) => j.stop());
}
