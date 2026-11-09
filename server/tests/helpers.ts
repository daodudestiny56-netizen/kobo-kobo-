import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db';
import type { Deps } from '../src/deps';
import { onboardMerchant, type Merchant, type Language } from '../src/merchants/service';

export const T0 = new Date('2026-11-13T09:00:00Z'); // 10:00 WAT on demo day

export function makeDeps(over: Partial<Deps> & { now?: Date } = {}): Deps & { setNow(d: Date): void } {
  let now = over.now ?? T0;
  return { db: over.db ?? openDb(), config: over.config ?? loadConfig({ LOG_LEVEL: 'silent' }), clock: over.clock ?? (() => now), setNow: (d: Date) => (now = d) } as any;
}

let n = 0;
export function makeMerchant(db: Db, o: Partial<{ phone: string; name: string; language: Language; rateBps: number; dailyCap: bigint; buffer: bigint; account: string }> = {}): Merchant {
  n++;
  const { merchant } = onboardMerchant(db, {
    phone: o.phone ?? `+23480312${String(30000 + n).padStart(5, '0')}`,
    fullName: o.name ?? `Trader ${n}`,
    bvn: `2220000${String(n).padStart(4, '0')}`,
    bankAccount: o.account ?? `01${String(23456000 + n).padStart(8, '0')}`,
    language: o.language ?? 'en',
    rateBps: o.rateBps,
    dailyCap: o.dailyCap,
    buffer: o.buffer,
    at: T0,
  });
  return merchant;
}
