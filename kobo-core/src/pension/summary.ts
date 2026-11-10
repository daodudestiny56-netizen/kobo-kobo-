import { AppError } from '../errors';
import type { Queryable } from '../db/pool';
import { dbToKobo, type Kobo } from '../money';
import { withdrawalEligibility, type Eligibility } from '../withdrawals/rules';

export interface PensionSummary {
  merchantId: string;
  rsaPin: string;
  emergency: Kobo;
  retirement: Kobo;
  total: Kobo;
  firstContributionAt: Date | null;
  lastWithdrawalAt: Date | null;
  eligibility: Eligibility;
}

/** Balances plus "can they cash out now, and if not, when" for the PWA, USSD and SMS. */
export async function getPensionSummary(db: Queryable, merchantId: string, now: Date): Promise<PensionSummary> {
  const { rows } = await db.query(
    `SELECT p.rsa_pin, p.emergency_balance::text AS e, p.retirement_balance::text AS r, p.first_contribution_at, p.last_withdrawal_at
       FROM merchants m LEFT JOIN pension_accounts p ON p.merchant_id = m.id WHERE m.id = $1`,
    [merchantId],
  );
  if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);
  if (!rows[0].rsa_pin) throw new AppError('PENSION_ACCOUNT_MISSING', 'Merchant has no RSA yet.', 422);
  const emergency = dbToKobo(rows[0].e);
  const retirement = dbToKobo(rows[0].r);
  return {
    merchantId,
    rsaPin: rows[0].rsa_pin,
    emergency,
    retirement,
    total: emergency + retirement,
    firstContributionAt: rows[0].first_contribution_at,
    lastWithdrawalAt: rows[0].last_withdrawal_at,
    eligibility: withdrawalEligibility({ firstContributionAt: rows[0].first_contribution_at, lastWithdrawalAt: rows[0].last_withdrawal_at, emergency }, now),
  };
}
