import { AppError } from '../errors';
import type { Deps } from '../deps';
import { withTx } from '../db/pool';
import { ExecutorError } from '../executors/types';
import { postJournal, reverseLines, withdrawalJournalLines } from '../ledger/ledger';
import { dbToKobo, koboToNaira, nairaDisplay, type Kobo } from '../money';
import { enqueueSms } from '../sms/outbox';
import { withdrawalConfirmed } from '../sms/templates';
import { sleep } from '../util/async';
import { withdrawalEligibility } from './rules';

export type WithdrawalStatus = 'PENDING' | 'APPROVED' | 'DISBURSED' | 'REJECTED';

export interface WithdrawalRecord {
  id: string;
  merchantId: string;
  amount: Kobo;
  destinationNuban: string;
  status: WithdrawalStatus;
  failureReason: string | null;
  creditReference: string | null;
  disbursedAt: Date | null;
}

const COLS = `w.id, p.merchant_id, w.amount::text, w.destination_nuban, w.status, w.failure_reason, w.credit_reference, w.disbursed_at, w.attempts`;
const FROM = `emergency_withdrawals w JOIN pension_accounts p ON p.id = w.pension_account_id`;

function map(r: Record<string, any>): WithdrawalRecord {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    amount: dbToKobo(r.amount),
    destinationNuban: r.destination_nuban,
    status: r.status,
    failureReason: r.failure_reason,
    creditReference: r.credit_reference,
    disbursedAt: r.disbursed_at,
  };
}

export const maskNuban = (n: string) => `****${n.slice(-4)}`;

async function load(deps: Deps, id: string): Promise<WithdrawalRecord> {
  const { rows } = await deps.db.query(`SELECT ${COLS} FROM ${FROM} WHERE w.id = $1`, [id]);
  if (!rows[0]) throw new AppError('WITHDRAWAL_NOT_FOUND', 'No such withdrawal.', 404);
  return map(rows[0]);
}

const ineligibleMessage: Record<string, string> = {
  NO_CONTRIBUTIONS: 'No contributions yet, so the Emergency Pot is not open.',
  NOT_VESTED: 'The Emergency Pot opens 3 months after your first contribution.',
  COOLDOWN_ACTIVE: 'Emergency withdrawals are limited to once every 60 days.',
  EMPTY: 'The Emergency Pot is empty.',
};

/**
 * Emergency withdrawal from the 50% contingent pot back to the merchant's OWN Access account.
 *  1. One transaction: lock the RSA row, check eligibility and balance, write the withdrawal (PENDING), post the
 *     ledger journal and reduce the pot. Funds are reserved before any money moves, so two requests cannot overspend.
 *  2. Ask the bank to credit (idempotent key `withdrawal:<id>`), with bounded retries.
 *  3. Confirmed -> DISBURSED + SMS. Final refusal -> reverse everything (REJECTED). Outcome unknown -> stays PENDING
 *     and `retryPendingWithdrawals` replays the same key; we never reverse a credit that may have gone through.
 */
export async function requestEmergencyWithdrawal(deps: Deps, a: { merchantId: string; amount: Kobo }): Promise<WithdrawalRecord> {
  if (a.amount <= 0n) throw new AppError('INVALID_AMOUNT', 'Amount must be greater than zero.', 400);
  const now = deps.clock();

  const id = await withTx(deps.db, async (c) => {
    const { rows } = await c.query(
      `SELECT p.id, p.emergency_balance::text AS e, p.first_contribution_at, p.last_withdrawal_at, m.access_nuban
         FROM merchants m JOIN pension_accounts p ON p.merchant_id = m.id WHERE m.id = $1 FOR UPDATE OF p`,
      [a.merchantId],
    );
    if (!rows[0]) {
      const m = await c.query('SELECT 1 FROM merchants WHERE id = $1', [a.merchantId]);
      throw m.rowCount === 0
        ? new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404)
        : new AppError('PENSION_ACCOUNT_MISSING', 'Merchant has no RSA yet.', 422);
    }
    const emergency = dbToKobo(rows[0].e);
    const elig = withdrawalEligibility({ firstContributionAt: rows[0].first_contribution_at, lastWithdrawalAt: rows[0].last_withdrawal_at, emergency }, now);
    if (!elig.eligible && elig.reason !== 'EMPTY') {
      throw new AppError(elig.reason!, ineligibleMessage[elig.reason!], 422, elig.eligibleOn ? { eligible_on: elig.eligibleOn.toISOString() } : undefined);
    }
    if (a.amount > emergency) {
      throw new AppError('INSUFFICIENT_EMERGENCY_BALANCE', `Only ${koboToNaira(emergency)} is available in the Emergency Pot.`, 422, { available: koboToNaira(emergency) });
    }

    const ins = await c.query<{ id: string }>(
      `INSERT INTO emergency_withdrawals (pension_account_id, amount, destination_nuban, status, previous_last_withdrawal_at, created_at)
       VALUES ($1,$2,$3,'PENDING',$4,$5) RETURNING id`,
      [rows[0].id, koboToNaira(a.amount), rows[0].access_nuban, rows[0].last_withdrawal_at, now],
    );
    const wid = ins.rows[0].id;
    await postJournal(c, { merchantId: a.merchantId, reference: `WDR-${wid}`, lines: withdrawalJournalLines(a.amount) });
    await c.query(`UPDATE pension_accounts SET emergency_balance = emergency_balance - $2, last_withdrawal_at = $3, updated_at = now() WHERE id = $1`, [
      rows[0].id,
      koboToNaira(a.amount),
      now,
    ]);
    return wid;
  });

  return completeWithdrawal(deps, id);
}

/** Drive a PENDING withdrawal to a final state if the bank gives a definite answer. Safe to call repeatedly. */
export async function completeWithdrawal(deps: Deps, id: string): Promise<WithdrawalRecord> {
  const w = await load(deps, id);
  if (w.status !== 'PENDING') return w;
  const cfg = deps.config.sweep;

  let lastError = '';
  for (let i = 0; i < cfg.inRunTries; i++) {
    await deps.db.query('UPDATE emergency_withdrawals SET attempts = attempts + 1 WHERE id = $1', [id]);
    try {
      const r = await deps.executor.credit({
        idempotencyKey: `withdrawal:${id}`,
        nuban: w.destinationNuban,
        amount: w.amount,
        narration: 'Kobo Kobo emergency withdrawal',
      });
      return await markDisbursed(deps, w, r.creditReference);
    } catch (e) {
      if (!(e instanceof ExecutorError)) throw e;
      if (!e.retryable) return reverseWithdrawal(deps, w, e.code, e.message);
      lastError = `${e.code}: ${e.message}`;
      await deps.db.query('UPDATE emergency_withdrawals SET last_error = $2 WHERE id = $1', [id, lastError]);
      if (i < cfg.inRunTries - 1) await sleep(cfg.backoffBaseMs * 2 ** i);
    }
  }
  return load(deps, id); // outcome unknown: stays PENDING, replayed later with the same key
}

async function markDisbursed(deps: Deps, w: WithdrawalRecord, creditReference: string): Promise<WithdrawalRecord> {
  await withTx(deps.db, async (c) => {
    const upd = await c.query(
      `UPDATE emergency_withdrawals SET status = 'DISBURSED', credit_reference = $2, disbursed_at = $3, last_error = NULL
        WHERE id = $1 AND status = 'PENDING'`,
      [w.id, creditReference, deps.clock()],
    );
    if (upd.rowCount === 0) return; // someone else finished it first
    const m = await c.query<{ phone_number: string; preferred_language: string }>('SELECT phone_number, preferred_language FROM merchants WHERE id = $1', [w.merchantId]);
    await enqueueSms(c, {
      merchantId: w.merchantId,
      to: m.rows[0].phone_number,
      kind: 'WITHDRAWAL',
      dedupeKey: `withdrawal:${w.id}`,
      at: deps.clock(),
      body: withdrawalConfirmed(m.rows[0].preferred_language, { amount: nairaDisplay(w.amount), account: maskNuban(w.destinationNuban) }),
    });
  });
  return load(deps, w.id);
}

/** The bank said no for good: give the money back to the pot and lift the cooldown this request started. */
async function reverseWithdrawal(deps: Deps, w: WithdrawalRecord, code: string, message: string): Promise<WithdrawalRecord> {
  await withTx(deps.db, async (c) => {
    const locked = await c.query(
      `SELECT w.status, w.previous_last_withdrawal_at, p.id AS pension_id FROM ${FROM} WHERE w.id = $1 FOR UPDATE OF w`,
      [w.id],
    );
    if (!locked.rows[0] || locked.rows[0].status !== 'PENDING') return;
    await postJournal(c, { merchantId: w.merchantId, reference: `WDR-REV-${w.id}`, lines: reverseLines(withdrawalJournalLines(w.amount)) });
    await c.query(`UPDATE pension_accounts SET emergency_balance = emergency_balance + $2, last_withdrawal_at = $3, updated_at = now() WHERE id = $1`, [
      locked.rows[0].pension_id,
      koboToNaira(w.amount),
      locked.rows[0].previous_last_withdrawal_at,
    ]);
    await c.query(`UPDATE emergency_withdrawals SET status = 'REJECTED', failure_reason = $2, last_error = $3 WHERE id = $1`, [w.id, code, message]);
  });
  return load(deps, w.id);
}

/** Replay every PENDING withdrawal older than `olderThanMs` (the scheduler calls this every minute). */
export async function retryPendingWithdrawals(deps: Deps, olderThanMs = 30_000): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM emergency_withdrawals WHERE status = 'PENDING' AND created_at < $1 ORDER BY created_at LIMIT 100`,
    [new Date(deps.clock().getTime() - olderThanMs)],
  );
  for (const r of rows) {
    try {
      await completeWithdrawal(deps, r.id);
    } catch (e) {
      console.error(`[withdrawals] retry of ${r.id} failed:`, (e as Error).message);
    }
  }
  return rows.length;
}
