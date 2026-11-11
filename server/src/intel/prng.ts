import { createHash } from 'node:crypto';

/** A small seeded generator (mulberry32). numpy's stream cannot be reproduced, so decisions are compared, not bits. */
export function seededRandom(seed: string): () => number {
  let a = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomInt = (rand: () => number, n: number): number => Math.floor(rand() * n);

/** In-place Fisher-Yates. */
export function shuffle<T>(rand: () => number, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(rand, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
