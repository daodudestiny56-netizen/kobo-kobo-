import { AppError } from './errors';

export const WAT_TZ = 'Africa/Lagos';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** WAT is UTC+1 all year (no daylight saving). */
export function toWatDate(d: Date): string {
  return new Date(d.getTime() + HOUR).toISOString().slice(0, 10);
}

export function assertDateString(s: unknown): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AppError('INVALID_DATE', 'Date must be YYYY-MM-DD.', 400);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new AppError('INVALID_DATE', 'Date is not a real calendar date.', 400);
  return s;
}

export function addDays(dateStr: string, n: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
}

/** The instant the sweep for `dateStr` is cut: 23:00 WAT that day (22:00 UTC). */
export function sweepCutoff(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 22, 0, 0));
}

/**
 * PRD v3 rolling window: [previous cutoff, this cutoff). A credit at 23:30 belongs to the NEXT sweep, and nothing
 * falls between two windows or is counted twice.
 */
export function sweepWindow(dateStr: string): { from: Date; to: Date } {
  return { from: sweepCutoff(addDays(dateStr, -1)), to: sweepCutoff(dateStr) };
}

/** The sweep date a credit settled at `at` falls into. */
export function sweepDateOf(at: Date): string {
  const wat = toWatDate(at);
  return at.getTime() >= sweepCutoff(wat).getTime() ? addDays(wat, 1) : wat;
}

/** The next sweep that has not been cut yet at `now` (what "tonight's sweep" means on screen). */
export const upcomingSweepDate = sweepDateOf;

export function addDaysToInstant(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}

export function addMonthsToInstant(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatWatDay(d: Date): string {
  const [y, m, day] = toWatDate(d).split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export const NEVER = '9999-12-31T00:00:00.000Z';
