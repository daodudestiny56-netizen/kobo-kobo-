import type { Kobo } from '../money';
import { addMonthsToInstant } from '../time';

/**
 * The ONE place that decides whether an emergency withdrawal is allowed (PRD 6.5). The app, USSD, SMS and the
 * spoken balance all call this, so no channel can say "available now" when it is not.
 * PenCom PPP Guidelines 2025: from 3 months after the first contribution, then at most once every 2 months.
 */
export type IneligibleReason = 'NO_CONTRIBUTIONS' | 'NOT_VESTED' | 'COOLDOWN_ACTIVE' | 'EMPTY' | 'RETIREMENT_LOCKED';

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  /** When the blocker lifts (NOT_VESTED / COOLDOWN_ACTIVE). */
  eligibleOn?: Date;
}

export function withdrawalEligibility(
  p: { firstContributionAt: Date | null; lastWithdrawalAt: Date | null; emergency: Kobo },
  now: Date,
  rules: { vestingMonths: number; cooldownMonths: number } = { vestingMonths: 3, cooldownMonths: 2 },
): Eligibility {
  if (!p.firstContributionAt) return { eligible: false, reason: 'NO_CONTRIBUTIONS' };
  const vestedOn = addMonthsToInstant(p.firstContributionAt, rules.vestingMonths);
  if (now < vestedOn) return { eligible: false, reason: 'NOT_VESTED', eligibleOn: vestedOn };
  if (p.lastWithdrawalAt) {
    const nextOn = addMonthsToInstant(p.lastWithdrawalAt, rules.cooldownMonths);
    if (now < nextOn) return { eligible: false, reason: 'COOLDOWN_ACTIVE', eligibleOn: nextOn };
  }
  if (p.emergency <= 0n) return { eligible: false, reason: 'EMPTY' };
  return { eligible: true };
}

/** The retirement pot is locked until age 50. There is no path to unlock it in the product. */
export const retirementLocked = (): Eligibility => ({ eligible: false, reason: 'RETIREMENT_LOCKED' });
