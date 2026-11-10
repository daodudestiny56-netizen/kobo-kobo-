// "INVALID_OTP: that code is not right." -> "that code is not right." Codes are for developers, not traders.
export function plainError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
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
