import { AppError } from '../errors';
import type { Deps } from '../deps';
import { sweepJournalLines, type LedgerLine } from '../ledger/ledger';
import { dbToKobo, koboToNaira, type Kobo } from '../money';
import { reservePenReference } from '../pfa/simulator';
import { splitSweep, type Split } from './engine';

export interface SplitPreview {
  merchantId: string;
  sweepDate: string;
  sweepAmount: Kobo;
  split: Split;
  pensionReference: string;
  ledger: LedgerLine[];
}

/**
 * What the Rails executor calls before it debits: validates the amount against the merchant's rules, reserves the
 * PEN reference (idempotent per merchant+date) and returns the 50/50 allocation with the ledger lines that
 * will be posted at settlement. Nothing is posted here.
 */
export async function previewSplit(deps: Deps, a: { merchantId: string; sweepDate: string; amount: Kobo }): Promise<SplitPreview> {
  const m = await deps.db.query<{ daily_cap: string; has_rsa: boolean }>(
    `SELECT m.daily_cap::text, (p.id IS NOT NULL) AS has_rsa
       FROM merchants m LEFT JOIN pension_accounts p ON p.merchant_id = m.id WHERE m.id = $1`,
    [a.merchantId],
  );
  const merchant = m.rows[0];
  if (!merchant) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);

  const cap = dbToKobo(merchant.daily_cap);
  if (a.amount > cap) {
    throw new AppError('AMOUNT_EXCEEDS_DAILY_CAP', `Sweep amount exceeds the merchant's daily cap of ${koboToNaira(cap)}.`, 422, {
      daily_cap: koboToNaira(cap),
    });
  }
  if (!merchant.has_rsa) {
    throw new AppError('PENSION_ACCOUNT_MISSING', 'Merchant has no RSA yet. Issue one via POST /api/v1/pfa/rsa-pin.', 422);
  }

  const existing = await deps.db.query<{ status: string; sweep_kobo: string; pension_reference: string | null }>(
    `SELECT status, (sweep_amount * 100)::bigint::text AS sweep_kobo, pension_reference
       FROM daily_sweeps WHERE merchant_id = $1 AND sweep_date = $2`,
    [a.merchantId, a.sweepDate],
  );
  const row = existing.rows[0];
  if (row && row.status !== 'PENDING') {
    throw new AppError(
      row.status === 'EXECUTED' ? 'SWEEP_ALREADY_EXECUTED' : 'SWEEP_ALREADY_RESOLVED',
      `A sweep for this merchant and date is already ${row.status}.`,
      409,
      { status: row.status, pension_reference: row.pension_reference },
    );
  }
  if (row && BigInt(row.sweep_kobo) !== a.amount) {
    throw new AppError('SWEEP_AMOUNT_CONFLICT', 'A pending sweep for this date exists with a different amount.', 409, {
      pending_amount: koboToNaira(BigInt(row.sweep_kobo)),
    });
  }

  const split = splitSweep(a.amount);
  const pensionReference = await reservePenReference(deps.db, a.merchantId, a.sweepDate);
  return {
    merchantId: a.merchantId,
    sweepDate: a.sweepDate,
    sweepAmount: a.amount,
    split,
    pensionReference,
    ledger: sweepJournalLines(a.amount, split),
  };
}
