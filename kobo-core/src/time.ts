import { AppError } from './errors';

/** West Africa Time is UTC+1 all year (no DST), so fixed-offset arithmetic is safe. */
export const WAT_TZ = 'Africa/Lagos';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The WAT calendar date (YYYY-MM-DD) of an instant. */
export function toWatDate(d: Date): string {
  return new Date(d.getTime() + HOUR).toISOString().slice(0, 10);
}

export function assertDateString(s: unknown): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new AppError('INVALID_DATE', 'Date must be YYYY-MM-DD.', 400);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new AppError('INVALID_DATE', 'Date is not a real calendar date.', 400);
  }
  return s;
}

export function addDays(dateStr: string, n: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
}

/** 23:00 WAT on the given date, as a UTC instant. */
export function sweepCutoff(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 22, 0, 0));
}

/**
 * The inflow window a sweep for `dateStr` covers, per PRD v2: [00:00 WAT, 23:00 WAT) of that date.
 * Takings settled in the 23:00-23:59 hour fall outside every sweep; reconciliation reports them as a note.
 */
export function sweepWindow(dateStr: string): { from: Date; to: Date } {
  const to = sweepCutoff(dateStr);
  return { from: new Date(to.getTime() - 23 * HOUR), to };
}

/** The 23:00-24:00 WAT hour of `dateStr`, which no sweep window covers. */
export function lateHour(dateStr: string): { from: Date; to: Date } {
  const from = sweepCutoff(dateStr);
  return { from, to: new Date(from.getTime() + HOUR) };
}

/** The sweep date an instant belongs to: its WAT calendar date. */
export function currentSweepDate(now: Date): string {
  return toWatDate(now);
}

export function addDaysToInstant(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}

export function addMonthsToInstant(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "12 Feb 2027" in WAT. */
export function formatWatDay(d: Date): string {
  const [y, m, day] = toWatDate(d).split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
