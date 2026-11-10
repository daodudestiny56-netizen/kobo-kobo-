import type { Db } from '../db';
import type { Deps } from '../deps';

/**
 * Demo clock (PRD 6.5): the vesting period cannot be waited out on stage, so demo mode can push the ELIGIBILITY
 * clock forward. It never moves the sweep window or the scheduler, only "is this withdrawal allowed yet".
 * The app shows a banner whenever the offset is non-zero.
 */
const KEY = 'clock_offset_days';

export function getOffsetDays(db: Db): number {
  const r = db.prepare('SELECT value FROM demo_state WHERE key = ?').get(KEY) as { value: string } | undefined;
  return r ? Number(r.value) : 0;
}

export function setOffsetDays(db: Db, days: number): void {
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('offset must be a whole number of days between 0 and 3650');
  db.prepare('INSERT INTO demo_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, String(days));
}

/** The time every eligibility check uses. */
export function eligibilityNow(deps: Pick<Deps, 'db' | 'clock' | 'config'>): Date {
  const days = deps.config.demoMode ? getOffsetDays(deps.db) : 0;
  return new Date(deps.clock().getTime() + days * 86_400_000);
}
