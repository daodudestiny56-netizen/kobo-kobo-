import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison for secrets. */
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
