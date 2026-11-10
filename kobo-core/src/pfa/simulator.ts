import { randomInt } from 'node:crypto';
import { AppError } from '../errors';
import type { Queryable } from '../db/pool';
import { dbToKobo, koboToNaira, type Kobo } from '../money';
import type { Split } from '../split/engine';

/**
 * Access ARM Pensions simulator (PFA side of the hackathon demo):
 *  - issues a mock ECRS RSA PIN at onboarding,
 *  - hands out PenCom-style contribution references (PEN-YYYYMMDD-NNNNNN),
 *  - credits a contribution into the two pots.
 * Swap this module for the real PFA client later; callers only use these three functions.
 */
export const PFA_CODE = 'ACCESS_ARM';
export const PFA_NAME = 'Access ARM Pensions';

export interface RsaIssue {
  merchantId: string;
  rsaPin: string;
  created: boolean;
}

/** Idempotent: a merchant gets exactly one RSA PIN, repeat calls return the same one. */
export async function issueRsaPin(db: Queryable, merchantId: string): Promise<RsaIssue> {
  const m = await db.query('SELECT 1 FROM merchants WHERE id = $1', [merchantId]);
  if (m.rowCount === 0) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);

  const existing = await db.query<{ rsa_pin: string }>('SELECT rsa_pin FROM pension_accounts WHERE merchant_id = $1', [merchantId]);
  if (existing.rows[0]) return { merchantId, rsaPin: existing.rows[0].rsa_pin, created: false };

  for (let attempt = 0; attempt < 5; attempt++) {
    const pin = `PEN1${String(randomInt(0, 100_000_000_000)).padStart(11, '0')}`; // PEN + 12 digits, like the PRD sample
    try {
      const ins = await db.query<{ rsa_pin: string }>(
        `INSERT INTO pension_accounts (merchant_id, rsa_pin, pfa_code) VALUES ($1,$2,$3)
         ON CONFLICT (merchant_id) DO NOTHING RETURNING rsa_pin`,
        [merchantId, pin, PFA_CODE],
      );
      if (ins.rows[0]) return { merchantId, rsaPin: ins.rows[0].rsa_pin, created: true };
      const again = await db.query<{ rsa_pin: string }>('SELECT rsa_pin FROM pension_accounts WHERE merchant_id = $1', [merchantId]);
      return { merchantId, rsaPin: again.rows[0].rsa_pin, created: false }; // lost a race to another request
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505' && err.constraint?.includes('rsa_pin')) continue; // PIN collision: draw another
      throw e;
    }
  }
  throw new Error('Could not allocate a unique RSA PIN');
}

/**
 * Reserve (or look up) the contribution reference for a merchant's sweep on a date.
 * Same (merchant, date) always returns the same reference, so retries and Rails/core double calls agree.
 * Numbers are sequential per date, which keeps the UNIQUE constraint collision-free at any volume.
 */
export async function reservePenReference(db: Queryable, merchantId: string, sweepDate: string): Promise<string> {
  const select = () =>
    db.query<{ reference: string }>('SELECT reference FROM pension_references WHERE merchant_id = $1 AND sweep_date = $2', [merchantId, sweepDate]);

  const found = await select();
  if (found.rows[0]) return found.rows[0].reference;

  const counter = await db.query<{ last_value: number }>(
    `INSERT INTO pen_reference_counters (ref_date, last_value) VALUES ($1, 1)
     ON CONFLICT (ref_date) DO UPDATE SET last_value = pen_reference_counters.last_value + 1
     RETURNING last_value`,
    [sweepDate],
  );
  const reference = `PEN-${sweepDate.replaceAll('-', '')}-${String(counter.rows[0].last_value).padStart(6, '0')}`;
  const ins = await db.query<{ reference: string }>(
    `INSERT INTO pension_references (merchant_id, sweep_date, reference) VALUES ($1,$2,$3)
     ON CONFLICT (merchant_id, sweep_date) DO NOTHING RETURNING reference`,
    [merchantId, sweepDate, reference],
  );
  if (ins.rows[0]) return ins.rows[0].reference;
  return (await select()).rows[0].reference; // a concurrent request reserved it first (our number is simply skipped)
}

export interface PotBalances {
  emergency: Kobo;
  retirement: Kobo;
}

/** Credit a contribution into both pots and stamp first_contribution_at (starts the 3-month vesting clock). */
export async function creditContribution(db: Queryable, merchantId: string, split: Split, at: Date): Promise<PotBalances> {
  const { rows } = await db.query<{ emergency_balance: string; retirement_balance: string }>(
    `UPDATE pension_accounts
        SET emergency_balance  = emergency_balance  + $2,
            retirement_balance = retirement_balance + $3,
            first_contribution_at = COALESCE(first_contribution_at, $4),
            updated_at = now()
      WHERE merchant_id = $1
      RETURNING emergency_balance::text, retirement_balance::text`,
    [merchantId, koboToNaira(split.emergency), koboToNaira(split.retirement), at],
  );
  if (!rows[0]) throw new AppError('PENSION_ACCOUNT_MISSING', 'Merchant has no RSA yet. Issue one via POST /api/v1/pfa/rsa-pin.', 422);
  return { emergency: dbToKobo(rows[0].emergency_balance), retirement: dbToKobo(rows[0].retirement_balance) };
}
