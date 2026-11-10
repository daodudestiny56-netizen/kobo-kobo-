import { randomInt, randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { AppError } from '../errors';
import { toWatDate } from '../time';

/**
 * Simulated Access ARM (PRD section 4: "Simulated by us"). Issues a stand-in RSA PIN, hands out unique
 * contribution references, and tracks the contribution dates the withdrawal rules need.
 */

/** Simulated RSA PIN: "PEN" + 12 digits, the usual shape. Not a real PenCom number. */
export function newRsaPin(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += randomInt(0, 10);
  return `PEN${s}`;
}

export function createPensionAccount(db: Db, merchantId: string, at: Date): { id: string; rsaPin: string } {
  const id = randomUUID();
  for (let i = 0; i < 5; i++) {
    const rsaPin = newRsaPin();
    try {
      db.prepare(`INSERT INTO pension_accounts (id, merchant_id, rsa_pin, created_at) VALUES (?,?,?,?)`).run(id, merchantId, rsaPin, at.toISOString());
      return { id, rsaPin };
    } catch (e) {
      if (!/UNIQUE.*rsa_pin/.test((e as Error).message)) throw e;
    }
  }
  throw new AppError('RSA_PIN_UNAVAILABLE', 'Could not allocate a simulated RSA PIN.', 503);
}

/**
 * Next contribution reference, PEN-YYYYMMDD-NNNNNN, unique and gap-free per sweep date. The day is the sweep date,
 * not the wall clock, so a late retry still sorts with its own night. Atomic: an upsert on a counter row.
 */
export function nextPenReference(db: Db, sweepDate: string): string {
  const r = db
    .prepare(`INSERT INTO pen_counters (day, last) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET last = last + 1 RETURNING last`)
    .get(sweepDate) as { last: number };
  return `PEN-${sweepDate.replaceAll('-', '')}-${String(r.last).padStart(6, '0')}`;
}

/** Called when a sweep settles. Only the first call sets the date that starts the vesting clock. */
export function recordContribution(db: Db, merchantId: string, at: Date): void {
  db.prepare(`UPDATE pension_accounts SET first_contribution_at = COALESCE(first_contribution_at, ?) WHERE merchant_id = ?`).run(at.toISOString(), merchantId);
}

export function recordWithdrawal(db: Db, merchantId: string, at: Date): void {
  db.prepare(`UPDATE pension_accounts SET last_withdrawal_at = ? WHERE merchant_id = ?`).run(at.toISOString(), merchantId);
}

export const penDay = toWatDate;
