import { AppError } from './errors';

/** All money is handled as integer kobo (bigint). Never floats. */
export type Kobo = bigint;

const INPUT_RE = /^\d{1,12}(\.\d{1,2})?$/;

/** Parse an API amount (string or number) such as "45000.00" or 900.5 into kobo. Rejects >2dp, negatives, exponents. */
export function parseNaira(input: unknown): Kobo {
  const s =
    typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : typeof input === 'string' ? input.trim() : '';
  if (!INPUT_RE.test(s)) {
    throw new AppError('INVALID_AMOUNT', 'Amount must be a non-negative naira value with at most 2 decimal places.', 400);
  }
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
}

export function parsePositiveNaira(input: unknown): Kobo {
  const k = parseNaira(input);
  if (k <= 0n) throw new AppError('INVALID_AMOUNT', 'Amount must be greater than zero.', 400);
  return k;
}

/** Parse a NUMERIC string coming back from Postgres (e.g. "45000.00"). */
export function dbToKobo(v: string | null | undefined): Kobo {
  if (v === null || v === undefined) return 0n;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`Unparseable numeric from database: ${v}`);
  const [, sign, whole, frac = ''] = m;
  const k = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
  return sign === '-' ? -k : k;
}

/** kobo -> "1234.50" (what we send to Postgres NUMERIC and to API clients). */
export function koboToNaira(k: Kobo): string {
  const neg = k < 0n;
  const a = neg ? -k : k;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** kobo -> "N36,800" / "N36,800.50". ASCII "N" on purpose: keeps SMS in the 160-char GSM-7 alphabet. */
export function nairaDisplay(k: Kobo): string {
  const neg = k < 0n;
  const a = neg ? -k : k;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = a % 100n;
  const body = frac === 0n ? whole : `${whole}.${frac.toString().padStart(2, '0')}`;
  return `${neg ? '-' : ''}N${body}`;
}

/** A percentage like "2.50" (or 2.5) -> 250n, i.e. hundredths of a percent. */
export function rateToHundredths(rate: string | number): bigint {
  const s = typeof rate === 'number' ? String(rate) : rate.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new AppError('INVALID_RATE', 'Rate must be a number with at most 2 decimal places.', 400);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** Display a hundredths-of-percent rate: 200n -> "2", 250n -> "2.5". */
export function rateDisplay(h: bigint): string {
  const whole = h / 100n;
  const frac = h % 100n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}

/** floor(takings * rate%). BigInt division floors for non-negatives. */
export function percentOf(takings: Kobo, rateHundredths: bigint): Kobo {
  return (takings * rateHundredths) / 10000n;
}

export const minKobo = (a: Kobo, b: Kobo): Kobo => (a < b ? a : b);
export const maxKobo = (a: Kobo, b: Kobo): Kobo => (a > b ? a : b);
