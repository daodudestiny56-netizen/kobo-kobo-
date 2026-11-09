import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db';
import type { Deps } from '../src/deps';
import { SimulatedBank } from '../src/bank/simulated';
import { AllowAllGuard } from '../src/guard/port';
import { onboardMerchant, type Merchant, type Language } from '../src/merchants/service';

export const T0 = new Date('2026-11-13T09:00:00Z'); // 10:00 WAT on demo day

export type TestDeps = Deps & { setNow(d: Date): void; advance(ms: number): void; bank: SimulatedBank };

export function makeDeps(over: Partial<Deps> & { now?: Date } = {}): TestDeps {
  let now = over.now ?? T0;
  const clock = over.clock ?? (() => now);
  return {
    db: over.db ?? openDb(),
    config: over.config ?? loadConfig({ LOG_LEVEL: 'silent' }),
    clock,
    bank: (over.bank as SimulatedBank) ?? new SimulatedBank(clock),
    guard: over.guard ?? new AllowAllGuard(),
    setNow: (d: Date) => (now = d),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  } as TestDeps;
}

/** Record a customer credit (what the webhook receiver will do). */
export function addInflow(db: Db, merchantId: string, amountKobo: bigint, settledAt: Date, ref?: string) {
  const id = `in-${++inflowN}`;
  db.prepare(`INSERT INTO inflows (id, merchant_id, event_id, bank_reference, amount_kobo, channel, settled_at, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    id, merchantId, `evt-${id}`, ref ?? `BR-${id}`, amountKobo, 'NIP_TRANSFER', settledAt.toISOString(), settledAt.toISOString(),
  );
  return id;
}
let inflowN = 0;

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

/** A merchant whose bank account exists in the simulated bank with the given balance. */
export function fundedMerchant(deps: TestDeps, o: Parameters<typeof makeMerchant>[1] = {}, balance = 100_000_00n) {
  const m = makeMerchant(deps.db, o);
  deps.bank.setBalance(m.bankAccount, balance);
  return m;
}

/** 10:00 WAT on 13 Nov is before the cutoff; 23:05 WAT is after it. */
export const AFTER_CUTOFF = new Date('2026-11-13T22:05:00Z');
export const DATE = '2026-11-13';
