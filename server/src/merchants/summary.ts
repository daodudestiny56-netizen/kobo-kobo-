import type { Deps } from '../deps';
import { pots, type Pots } from '../ledger/ledger';
import { eligibilityNow, getOffsetDays } from '../demo/clock';
import { percentOf, toKobo, type Kobo } from '../money';
import { sweepCutoff, upcomingSweepDate } from '../time';
import { withdrawalEligibility, type Eligibility } from '../withdrawals/eligibility';
import { windowInflows } from '../sweeps/engine';
import { getMerchant, isPaused, type Merchant } from './service';

export interface Summary {
  merchant: Merchant;
  paused: boolean;
  /** The sweep that has not been cut yet, and what has counted toward it so far. */
  nextSweepDate: string;
  nextSweepAt: Date;
  takingsToday: Kobo;
  estimatedSweep: Kobo;
  pots: Pots;
  eligibility: Eligibility;
  firstContributionAt: Date | null;
  lastWithdrawalAt: Date | null;
  demoClockOffsetDays: number;
}

export function pensionDates(db: Deps['db'], merchantId: string) {
  const r = db.prepare('SELECT first_contribution_at f, last_withdrawal_at l FROM pension_accounts WHERE merchant_id = ?').get(merchantId) as { f: string | null; l: string | null } | undefined;
  return { firstContributionAt: r?.f ? new Date(r.f) : null, lastWithdrawalAt: r?.l ? new Date(r.l) : null };
}

export function eligibilityFor(deps: Deps, merchantId: string, emergency: Kobo): Eligibility {
  return withdrawalEligibility({ ...pensionDates(deps.db, merchantId), emergency }, eligibilityNow(deps), deps.config);
}

/** Everything the app, USSD and SMS show, computed in one place so the channels cannot disagree. */
export function merchantSummary(deps: Deps, merchantId: string): Summary {
  const merchant = getMerchant(deps.db, merchantId);
  const now = deps.clock();
  const date = upcomingSweepDate(now);
  const { total } = windowInflows(deps.db, merchantId, date);
  const p = pots(deps.db, merchantId);
  const raw = percentOf(total, BigInt(merchant.rateBps));
  return {
    merchant,
    paused: isPaused(merchant, now),
    nextSweepDate: date,
    nextSweepAt: sweepCutoff(date),
    takingsToday: total,
    estimatedSweep: raw < merchant.dailyCap ? raw : merchant.dailyCap,
    pots: p,
    eligibility: eligibilityFor(deps, merchantId, p.emergency),
    ...pensionDates(deps.db, merchantId),
    demoClockOffsetDays: deps.config.demoMode ? getOffsetDays(deps.db) : 0,
  };
}

export { toKobo };
