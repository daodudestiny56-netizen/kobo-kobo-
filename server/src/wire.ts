/**
 * JSON on the wire: snake_case keys, bigint kobo as plain integers (safe below 9e15 kobo), dates as ISO strings.
 * Domain code stays camelCase; only the HTTP layer converts.
 */
// Only camelCase identifiers are converted; data keys (status names such as SKIPPED_PAUSED) pass through.
const snake = (k: string) => (/^[a-z][a-zA-Z0-9]*$/.test(k) ? k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : k);

export function toWire(v: unknown): unknown {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount too large for JSON');
    return Number(v);
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), toWire(x)]));
  return v;
}
