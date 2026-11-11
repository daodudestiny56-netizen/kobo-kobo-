import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { AppError } from '../errors';
import { toKobo, type Kobo } from '../money';
import type { Split } from '../split/engine';

export type Account = 'MERCHANT_BANK' | 'PFA_COLLECTION' | 'EMERGENCY_POT' | 'RETIREMENT_POT';
export interface Line {
  account: Account;
  /** Signed kobo: debit negative, credit positive. */
  amount: Kobo;
}

interface Group {
  groupId: string;
  merchantId: string;
  sweepId?: string | null;
  withdrawalId?: string | null;
  reference: string;
  lines: Line[];
  at: Date;
}

/**
 * Append one balanced group of entries. Idempotent: a group id that already exists is left alone and `false` is
 * returned, so replaying a settlement can never double-post. Call inside a transaction.
 */
export function postGroup(db: Db, g: Group): boolean {
  if (g.lines.length < 2) throw new Error('A ledger group needs at least two lines');
  if (g.lines.some((l) => l.amount === 0n)) throw new Error('A ledger line cannot be zero');
  const sum = g.lines.reduce((s, l) => s + l.amount, 0n);
  if (sum !== 0n) throw new Error(`Ledger group ${g.groupId} does not sum to zero (${sum})`);
  const exists = db.prepare('SELECT 1 FROM ledger_entries WHERE group_id = ? LIMIT 1').get(g.groupId);
  if (exists) return false;
  const ins = db.prepare(
    `INSERT INTO ledger_entries (id, group_id, merchant_id, sweep_id, withdrawal_id, account, amount_kobo, reference, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const l of g.lines) {
    ins.run(randomUUID(), g.groupId, g.merchantId, g.sweepId ?? null, g.withdrawalId ?? null, l.account, l.amount, g.reference, g.at.toISOString());
  }
  return true;
}

/** Balance of one account, always computed from the entries. */
export function balanceOf(db: Db, merchantId: string, account: Account): Kobo {
  const r = db.prepare('SELECT COALESCE(SUM(amount_kobo),0) AS b FROM ledger_entries WHERE merchant_id = ? AND account = ?').get(merchantId, account) as { b: number };
  return toKobo(r.b);
}

export interface Pots {
  emergency: Kobo;
  retirement: Kobo;
  total: Kobo;
}
export function pots(db: Db, merchantId: string): Pots {
  const emergency = balanceOf(db, merchantId, 'EMERGENCY_POT');
  const retirement = balanceOf(db, merchantId, 'RETIREMENT_POT');
  return { emergency, retirement, total: emergency + retirement };
}

/**
 * A settled sweep (PRD 6.4): the money leaves the trader's account into the PFA collection account, then the
 * pension allocates it to the two pots. Two balanced groups.
 */
export function settleSweepGroups(a: { sweepId: string; merchantId: string; reference: string; sweep: Kobo; split: Split; at: Date }) {
  if (a.split.emergency + a.split.retirement !== a.sweep) throw new Error('Split does not add up to the sweep amount');
  const base = { merchantId: a.merchantId, sweepId: a.sweepId, reference: a.reference, at: a.at };
  const toPots: Line[] = [{ account: 'PFA_COLLECTION', amount: -a.sweep }];
  if (a.split.emergency > 0n) toPots.push({ account: 'EMERGENCY_POT', amount: a.split.emergency });
  if (a.split.retirement > 0n) toPots.push({ account: 'RETIREMENT_POT', amount: a.split.retirement });
  return [
    { ...base, groupId: `${a.sweepId}:collect`, lines: [{ account: 'MERCHANT_BANK', amount: -a.sweep } as Line, { account: 'PFA_COLLECTION', amount: a.sweep } as Line] },
    { ...base, groupId: `${a.sweepId}:allocate`, lines: toPots },
  ];
}

/** The exact contra entries of a settled sweep, posted when the bank reverses it. */
export function reverseSweepGroups(a: { sweepId: string; merchantId: string; reference: string; sweep: Kobo; split: Split; at: Date }) {
  return settleSweepGroups(a).map((g) => ({
    ...g,
    groupId: g.groupId.replace(/:(collect|allocate)$/, ':reverse-$1'),
    reference: `${a.reference}-REV`,
    lines: g.lines.map((l) => ({ ...l, amount: -l.amount })),
  }));
}

/**
 * Integrity check used by reconciliation and tests: every group sums to zero and no pot is negative.
 */
export function ledgerProblems(db: Db): string[] {
  const out: string[] = [];
  const bad = db.prepare('SELECT group_id, SUM(amount_kobo) s FROM ledger_entries GROUP BY group_id HAVING s <> 0').all() as { group_id: string; s: number }[];
  for (const b of bad) out.push(`group ${b.group_id} sums to ${b.s}`);
  const neg = db
    .prepare(`SELECT merchant_id, account, SUM(amount_kobo) s FROM ledger_entries WHERE account IN ('EMERGENCY_POT','RETIREMENT_POT') GROUP BY merchant_id, account HAVING s < 0`)
    .all() as { merchant_id: string; account: string; s: number }[];
  for (const n of neg) out.push(`${n.account} of ${n.merchant_id} is negative (${n.s})`);
  const pfa = db.prepare(`SELECT SUM(amount_kobo) s FROM ledger_entries WHERE account = 'PFA_COLLECTION'`).get() as { s: number | null };
  if (pfa.s && pfa.s !== 0) out.push(`PFA_COLLECTION does not net to zero (${pfa.s})`);
  return out;
}

export function assertPostable(ok: boolean, what: string): void {
  if (!ok) throw new AppError('LEDGER_CONFLICT', `${what} was already posted.`, 409);
}
