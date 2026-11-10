import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool';
import { dbToKobo, koboToNaira, type Kobo } from '../money';
import type { Split } from '../split/engine';

/**
 * Immutable double-entry ledger. Sign convention (same everywhere):
 *   DEBIT  = the account's balance goes down, CREDIT = it goes up.
 *   Sweep:      DEBIT MERCHANT_CASH S | CREDIT EMERGENCY_POT e | CREDIT RETIREMENT_POT r
 *   Withdrawal: DEBIT EMERGENCY_POT w | CREDIT MERCHANT_CASH w
 * The database also refuses unbalanced journals (deferred trigger) and any UPDATE/DELETE.
 */
export type AccountType = 'MERCHANT_CASH' | 'EMERGENCY_POT' | 'RETIREMENT_POT' | 'PFA_ESCROW';
export type EntryType = 'DEBIT' | 'CREDIT';

export interface LedgerLine {
  accountType: AccountType;
  entryType: EntryType;
  amount: Kobo;
}

/** Zero-amount lines are omitted (the schema requires amount > 0), e.g. a 1-kobo sweep has no emergency leg. */
export function sweepJournalLines(sweep: Kobo, split: Split): LedgerLine[] {
  if (split.emergency + split.retirement !== sweep) throw new Error('Split does not add up to the sweep amount');
  const lines: LedgerLine[] = [{ accountType: 'MERCHANT_CASH', entryType: 'DEBIT', amount: sweep }];
  if (split.emergency > 0n) lines.push({ accountType: 'EMERGENCY_POT', entryType: 'CREDIT', amount: split.emergency });
  if (split.retirement > 0n) lines.push({ accountType: 'RETIREMENT_POT', entryType: 'CREDIT', amount: split.retirement });
  return lines;
}

export function withdrawalJournalLines(amount: Kobo): LedgerLine[] {
  return [
    { accountType: 'EMERGENCY_POT', entryType: 'DEBIT', amount },
    { accountType: 'MERCHANT_CASH', entryType: 'CREDIT', amount },
  ];
}

/** The exact mirror image of a journal (used to undo a withdrawal whose bank credit failed). */
export function reverseLines(lines: LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({ ...l, entryType: l.entryType === 'DEBIT' ? 'CREDIT' : 'DEBIT' }));
}

export function assertBalanced(lines: LedgerLine[]): void {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    if (l.amount <= 0n) throw new Error('Ledger lines must have a positive amount');
    if (l.entryType === 'DEBIT') debit += l.amount;
    else credit += l.amount;
  }
  if (debit !== credit) throw new Error(`Unbalanced journal: debits ${debit} vs credits ${credit}`);
}

/** Write one journal. Call inside the caller's transaction so it commits atomically with the state change it records. */
export async function postJournal(
  db: Queryable,
  p: { merchantId: string; sweepId?: string | null; reference: string; lines: LedgerLine[] },
): Promise<string> {
  assertBalanced(p.lines);
  const journalId = randomUUID();
  for (const l of p.lines) {
    await db.query(
      `INSERT INTO ledger_entries (journal_id, sweep_id, merchant_id, account_type, entry_type, amount, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [journalId, p.sweepId ?? null, p.merchantId, l.accountType, l.entryType, koboToNaira(l.amount), p.reference],
    );
  }
  return journalId;
}

export type LedgerBalances = Record<AccountType, Kobo>;

/** Net position per account derived purely from the ledger (credits minus debits). */
export async function ledgerBalances(db: Queryable, merchantId: string): Promise<LedgerBalances> {
  const { rows } = await db.query<{ account_type: AccountType; net: string }>(
    `SELECT account_type,
            SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY account_type`,
    [merchantId],
  );
  const out: LedgerBalances = { MERCHANT_CASH: 0n, EMERGENCY_POT: 0n, RETIREMENT_POT: 0n, PFA_ESCROW: 0n };
  for (const r of rows) out[r.account_type] = dbToKobo(r.net);
  return out;
}
