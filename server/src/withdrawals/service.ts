import { randomUUID } from 'node:crypto';
import { recordWithdrawal } from '../arm/simulator';
import { BankError, type TransferResult } from '../bank/port';
import type { Deps } from '../deps';
import { eligibilityNow } from '../demo/clock';
import { tx, type Db } from '../db';
import { AppError } from '../errors';
import { postGroup } from '../ledger/ledger';
import { addMessage } from '../messages/service';
import * as T from '../messages/templates';
import { eligibilityFor } from '../merchants/summary';
import { getMerchant } from '../merchants/service';
import { nairaDisplay, toKobo, type Kobo } from '../money';
import { pots } from '../ledger/ledger';
import { retirementLocked, type Eligibility } from './eligibility';

/**
 * Emergency withdrawal (PRD 6.5). Funds are RESERVED in the ledger the moment the request is accepted (pot ->
 * PFA collection) so two requests can never overdraw the pot, then paid from the collection stand-in account to the
 * trader's own linked account. Same money-safety rules as sweeps: persist before calling the bank, never resend after
 * a timeout, requery until final, release the reservation if the payout definitively fails.
 */
export type WithdrawalStatus = 'REQUESTED' | 'UNKNOWN' | 'DISBURSED' | 'REJECTED' | 'FAILED';

export interface Withdrawal {
  id: string;
  merchantId: string;
  amount: Kobo;
  destinationAccount: string;
  status: WithdrawalStatus;
  rejectReason: string | null;
  bankReference: string | null;
  createdAt: string;
}

const map = (r: any): Withdrawal => ({
  id: r.id, merchantId: r.merchant_id, amount: toKobo(r.amount_kobo), destinationAccount: r.destination_account, status: r.status,
  rejectReason: r.reject_reason, bankReference: r.bank_reference, createdAt: r.created_at,
});
export const getWithdrawal = (db: Db, id: string): Withdrawal | null => {
  const r = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  return r ? map(r) : null;
};
export const listWithdrawals = (db: Db, merchantId: string): Withdrawal[] =>
  (db.prepare('SELECT * FROM withdrawals WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC').all(merchantId) as any[]).map(map);

const iso = (d: Date) => d.toISOString();
const later = (now: Date, ms: number) => iso(new Date(now.getTime() + ms));

export interface WithdrawalOutcome {
  withdrawal: Withdrawal;
  accepted: boolean;
  /** The trader-facing sentence, in their language. The same text on every channel. */
  message: string;
  eligibility?: Eligibility;
}

/** Re-derive last_withdrawal_at from the withdrawals that still count (not rejected, not failed). */
function syncLastWithdrawal(db: Db, merchantId: string, now: Date) {
  const r = db.prepare(`SELECT MAX(effective_at) m FROM withdrawals WHERE merchant_id = ? AND status IN ('REQUESTED','UNKNOWN','DISBURSED')`).get(merchantId) as { m: string | null };
  if (r.m) recordWithdrawal(db, merchantId, new Date(r.m));
  else db.prepare('UPDATE pension_accounts SET last_withdrawal_at = NULL WHERE merchant_id = ?').run(merchantId);
  void now;
}

function reject(deps: Deps, merchantId: string, amount: Kobo, dest: string, reason: string, message: string, e?: Eligibility): WithdrawalOutcome {
  const now = deps.clock();
  const id = randomUUID();
  deps.db
    .prepare(`INSERT INTO withdrawals (id, merchant_id, amount_kobo, destination_account, status, reject_reason, effective_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, merchantId, amount, dest, 'REJECTED', reason, iso(eligibilityNow(deps)), iso(now), iso(now));
  return { withdrawal: getWithdrawal(deps.db, id)!, accepted: false, message, eligibility: e };
}

export async function requestWithdrawal(deps: Deps, merchantId: string, amount: Kobo, pot: 'EMERGENCY' | 'RETIREMENT' = 'EMERGENCY'): Promise<WithdrawalOutcome> {
  if (amount <= 0n) throw new AppError('INVALID_AMOUNT', 'Amount must be greater than zero.', 400);
  const m = getMerchant(deps.db, merchantId);
  const elig = pot === 'RETIREMENT' ? retirementLocked() : eligibilityFor(deps, merchantId, pots(deps.db, merchantId).emergency);
  if (!elig.eligible) return reject(deps, m.id, amount, m.bankAccount, elig.reason!, T.withdrawalRefusal(m.language, elig), elig);

  const now = deps.clock();
  const eff = eligibilityNow(deps);
  // Reserve inside one synchronous transaction: the balance check and the debit cannot be interleaved with another request.
  const reserved = tx(deps.db, () => {
    const available = pots(deps.db, m.id).emergency;
    if (amount > available) return null;
    const id = randomUUID();
    deps.db
      .prepare(`INSERT INTO withdrawals (id, merchant_id, amount_kobo, destination_account, status, bank_reference, effective_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, m.id, amount, m.bankAccount, 'REQUESTED', `WDR-${id.replaceAll('-', '').slice(0, 14)}`, iso(eff), iso(now), iso(now));
    postGroup(deps.db, {
      groupId: `${id}:reserve`, merchantId: m.id, withdrawalId: id, reference: `WDR-${id.slice(0, 8)}`, at: now,
      lines: [{ account: 'EMERGENCY_POT', amount: -amount }, { account: 'PFA_COLLECTION', amount }],
    });
    syncLastWithdrawal(deps.db, m.id, now);
    return id;
  });
  if (!reserved) {
    const available = pots(deps.db, m.id).emergency;
    return reject(deps, m.id, amount, m.bankAccount, 'EXCEEDS_BALANCE', T.amountTooHigh(m.language, { available: nairaDisplay(available) }));
  }
  const w = await advanceWithdrawal(deps, reserved);
  return { withdrawal: w, accepted: true, message: T.cashoutReply(m.language, { amount: nairaDisplay(amount) }) };
}

const busy = new Set<string>();

export async function advanceWithdrawal(deps: Deps, id: string): Promise<Withdrawal> {
  const w = getWithdrawal(deps.db, id)!;
  if (busy.has(id) || (w.status !== 'REQUESTED' && w.status !== 'UNKNOWN')) return w;
  busy.add(id);
  try {
    const m = getMerchant(deps.db, w.merchantId);
    const now = deps.clock();
    if (w.status === 'UNKNOWN') {
      // Outcome unknown: ask the bank, never pay again.
      try {
        const res = await deps.bank.getTransfer(w.bankReference!);
        if (res) return applyWithdrawalResult(deps, id, res);
      } catch (e) {
        if (!(e instanceof BankError)) throw e;
        return setNext(deps.db, id, now, `${e.code}: ${e.message}`);
      }
      // The bank has no record: the earlier call never landed, so paying with the same reference is safe.
    }
    let stage: 'enquiry' | 'transfer' = 'enquiry';
    try {
      const ne = await deps.bank.nameEnquiry(m.bankAccount);
      stage = 'transfer';
      const res = await deps.bank.transfer({
        sourceAccount: deps.config.collectionAccount, destinationAccount: m.bankAccount, nameEnquiryRef: ne.nameEnquiryRef, amount: w.amount,
        narration: 'Kobo Kobo emergency withdrawal', reference: w.bankReference!, idempotencyKey: `withdrawal:${w.id}`,
      });
      return applyWithdrawalResult(deps, id, res);
    } catch (e) {
      if (!(e instanceof BankError)) throw e;
      const err = `${e.code}: ${e.message}`;
      if (stage === 'transfer' && e.unknownOutcome) return markUnknown(deps.db, id, now, err);
      if (e.notProcessed || (stage === 'enquiry' && e.unknownOutcome)) return setNext(deps.db, id, now, err);
      return failWithdrawal(deps, id, err);
    }
  } finally {
    busy.delete(id);
  }
}

function setNext(db: Db, id: string, now: Date, err: string): Withdrawal {
  db.prepare('UPDATE withdrawals SET last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?').run(err, later(now, 30_000), iso(now), id);
  return getWithdrawal(db, id)!;
}
function markUnknown(db: Db, id: string, now: Date, err: string): Withdrawal {
  db.prepare(`UPDATE withdrawals SET status = 'UNKNOWN', last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?`).run(err, later(now, 30_000), iso(now), id);
  return getWithdrawal(db, id)!;
}

export function applyWithdrawalResult(deps: Deps, id: string, res: TransferResult): Withdrawal {
  const w = getWithdrawal(deps.db, id)!;
  const now = deps.clock();
  if (w.status === 'DISBURSED' || w.status === 'FAILED' || w.status === 'REJECTED') return w;
  if (res.status === 'pending') return markUnknown(deps.db, id, now, 'pending at the bank');
  if (res.status === 'failed' || res.status === 'reversed') return failWithdrawal(deps, id, res.failureCode ?? res.status.toUpperCase());
  if (res.amount !== w.amount) return markUnknown(deps.db, id, now, `AMOUNT_MISMATCH: asked ${w.amount}, bank moved ${res.amount}`);
  return tx(deps.db, () => {
    const m = getMerchant(deps.db, w.merchantId);
    postGroup(deps.db, {
      groupId: `${id}:pay`, merchantId: w.merchantId, withdrawalId: id, reference: w.bankReference!, at: now,
      lines: [{ account: 'PFA_COLLECTION', amount: -w.amount }, { account: 'MERCHANT_BANK', amount: w.amount }],
    });
    deps.db.prepare(`UPDATE withdrawals SET status = 'DISBURSED', last_error = NULL, next_check_at = NULL, updated_at = ? WHERE id = ?`).run(iso(now), id);
    addMessage(deps.db, { merchantId: m.id, kind: 'WITHDRAWAL_PAID', language: m.language, dedupeKey: `wdr-paid:${id}`, at: now, body: T.withdrawalPaid(m.language, { amount: nairaDisplay(w.amount), account: m.bankAccount }) });
    return getWithdrawal(deps.db, id)!;
  });
}

/** Definitive failure: release the reservation (the pot is whole again), restore the cooldown, tell the trader. */
function failWithdrawal(deps: Deps, id: string, reason: string): Withdrawal {
  const now = deps.clock();
  return tx(deps.db, () => {
    const w = getWithdrawal(deps.db, id)!;
    if (w.status !== 'REQUESTED' && w.status !== 'UNKNOWN') return w;
    postGroup(deps.db, {
      groupId: `${id}:release`, merchantId: w.merchantId, withdrawalId: id, reference: `${w.bankReference}-REL`, at: now,
      lines: [{ account: 'PFA_COLLECTION', amount: -w.amount }, { account: 'EMERGENCY_POT', amount: w.amount }],
    });
    deps.db.prepare(`UPDATE withdrawals SET status = 'FAILED', reject_reason = ?, last_error = ?, next_check_at = NULL, updated_at = ? WHERE id = ?`).run(reason, reason, iso(now), id);
    syncLastWithdrawal(deps.db, w.merchantId, now);
    const m = getMerchant(deps.db, w.merchantId);
    addMessage(deps.db, { merchantId: m.id, kind: 'WITHDRAWAL_FAILED', language: m.language, dedupeKey: `wdr-failed:${id}`, at: now, body: T.withdrawalFailed(m.language) });
    return getWithdrawal(deps.db, id)!;
  });
}

export async function requeryWithdrawalsDue(deps: Deps): Promise<number> {
  const rows = deps.db
    .prepare(`SELECT id FROM withdrawals WHERE status IN ('REQUESTED','UNKNOWN') AND (next_check_at IS NULL OR next_check_at <= ?) LIMIT 50`)
    .all(iso(deps.clock())) as { id: string }[];
  for (const r of rows) {
    try {
      await advanceWithdrawal(deps, r.id);
    } catch (e) {
      console.error(`[requery] withdrawal ${r.id}:`, (e as Error).message);
    }
  }
  return rows.length;
}
