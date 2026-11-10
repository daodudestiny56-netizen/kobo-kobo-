/** Normalise Nigerian numbers to +234XXXXXXXXXX. Returns null if it does not look like one. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s()-]/g, '');
  if (/^\+234\d{10}$/.test(s)) return s;
  if (/^234\d{10}$/.test(s)) return `+${s}`;
  if (/^0\d{10}$/.test(s)) return `+234${s.slice(1)}`;
  return null;
}
