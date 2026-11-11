// Money is integer kobo everywhere (PRD section 6).
export function naira(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}₦${whole.toLocaleString('en-NG')}${rem ? '.' + String(rem).padStart(2, '0') : ''}`;
}

// USSD and SMS use a plain "N" because feature phones cannot show the naira sign.
export function nairaPlain(kobo: number): string {
  return naira(kobo).replace('₦', 'N');
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// "2026-11-10" (a sweep date) -> "10 Nov 2026"
export function fmtDay(iso: string): string {
  return fmtDate(new Date(`${iso}T12:00:00`).getTime());
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function pct(bps: number): string {
  return `${bps / 100}%`;
}

// Compact amounts for chart axes and tight spaces: ₦850, ₦28k, ₦1.2m.
export function nairaShort(kobo: number): string {
  const n = Math.abs(kobo) / 100;
  const sign = kobo < 0 ? '-' : '';
  if (n >= 1_000_000) return `${sign}₦${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 10_000) return `${sign}₦${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${sign}₦${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${sign}₦${Math.round(n)}`;
}

// "10 Nov" for chart labels.
export function fmtShortDay(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// "Today", "Yesterday", or "Mon 9 Nov" for grouping a feed.
export function dayHeading(ts: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(ts) === day(now)) return 'Today';
  if (day(ts) === day(now - 86_400_000)) return 'Yesterday';
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
