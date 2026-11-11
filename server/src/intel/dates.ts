// Calendar helpers for sweep days ("YYYY-MM-DD"). Pure: no clock, no time zone surprises (everything is UTC midnight).
const DAY = 86_400_000;

export const parseDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const formatDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => formatDay(parseDay(day) + n * DAY);
export const daysBetween = (from: string, to: string): number => Math.round((parseDay(to) - parseDay(from)) / DAY);

/** Monday = 0 ... Sunday = 6, the same convention as the Python reference. */
export const weekday = (day: string): number => (new Date(parseDay(day)).getUTCDay() + 6) % 7;
