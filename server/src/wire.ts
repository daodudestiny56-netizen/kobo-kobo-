/**
 * JSON on the wire: camelCase as the domain code writes it, bigint kobo as plain integers (safe below 9e15 kobo),
 * dates as ISO strings. Endpoints that the web app reads as epoch milliseconds convert explicitly in src/web.
 */
export function toWire(v: unknown): unknown {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount too large for JSON');
    return Number(v);
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWire(x)]));
  return v;
}
