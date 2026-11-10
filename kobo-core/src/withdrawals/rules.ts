import type { Kobo } from '../money';
import { addDaysToInstant, addMonthsToInstant } from '../time';

/** PenCom PPP: first emergency withdrawal after 3 months, then at most once every 60 days (PRD: "every 2 months"). */
export const VESTING_MONTHS = 3;
export const COOLDOWN_DAYS = 60;

export type IneligibleReason = 'NO_CONTRIBUTIONS' | 'NOT_VESTED' | 'COOLDOWN_ACTIVE' | 'EMPTY';

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  /** When the blocker lifts (NOT_VESTED / COOLDOWN_ACTIVE). */
  eligibleOn?: Date;
}

export function withdrawalEligibility(
  p: { firstContributionAt: Date | null; lastWithdrawalAt: Date | null; emergency: Kobo },
  now: Date,
): Eligibility {
  if (!p.firstContributionAt) return { eligible: false, reason: 'NO_CONTRIBUTIONS' };
  const vestedOn = addMonthsToInstant(p.firstContributionAt, VESTING_MONTHS);
  if (now < vestedOn) return { eligible: false, reason: 'NOT_VESTED', eligibleOn: vestedOn };
  if (p.lastWithdrawalAt) {
    const nextOn = addDaysToInstant(p.lastWithdrawalAt, COOLDOWN_DAYS);
    if (now < nextOn) return { eligible: false, reason: 'COOLDOWN_ACTIVE', eligibleOn: nextOn };
  }
  if (p.emergency <= 0n) return { eligible: false, reason: 'EMPTY' };
  return { eligible: true };
}
