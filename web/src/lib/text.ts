import { ApiError } from './api/errors';

// "INVALID_OTP: that code is not right." -> "that code is not right." Codes are for developers, not traders.
export function plainError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiError) {
    if (e.code === 'NETWORK') return 'We could not reach Kobo Kobo. Check your connection and try again.';
    // The server has not built this endpoint yet (live mode only).
    if (e.status === 404 && e.code.startsWith('HTTP_')) return 'This is not available on the server yet.';
    if (e.code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute and try again.';
  }
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!msg) return fallback;
  const cleaned = msg.replace(/^[A-Z_]{4,}:\s*/, '');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Accepts 0803..., 234803... and +234803..., and returns +234803...
export function normalisePhone(input: string): string {
  const raw = input.replace(/[\s()-]/g, '');
  if (/^0\d{10}$/.test(raw)) return `+234${raw.slice(1)}`;
  if (/^234\d{10}$/.test(raw)) return `+${raw}`;
  return raw;
}

export const isPhone = (p: string) => /^\+234\d{10}$/.test(p);
export const isElevenDigits = (v: string) => /^\d{11}$/.test(v);

// Banks return names in capitals. Show those as a person would write them; leave mixed-case names alone.
export function displayName(name: string): string {
  if (!name || name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

export const firstName = (name: string): string => displayName(name).split(' ')[0];
