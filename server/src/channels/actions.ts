import type { Deps } from '../deps';
import { findMerchantByPhone as byPhone, getMerchant, pauseMerchant, resumeMerchant, setRateBps, type Merchant } from '../merchants/service';
import { rateToHundredths } from '../money';
import { normalizePhone } from '../phone';

/**
 * What a trader can do from a feature phone, shared by USSD and SMS so both behave identically, and the same
 * writes the app makes: rate_bps, paused_until, status.
 */
export function merchantByPhone(deps: Deps, raw: string): Merchant | null {
  const phone = normalizePhone(raw);
  return phone ? byPhone(deps.db, phone) : null;
}

/** "3", "2.5", "3%" -> basis points (hundredths of a percent); null unless it is between 1 and 5. */
export function parseRateBps(input: string): number | null {
  const s = input.trim().replace(/%$/, '');
  if (!/^\d(\.\d{1,2})?$/.test(s)) return null;
  const bps = Number(rateToHundredths(s));
  return bps >= 100 && bps <= 500 ? bps : null;
}

/** A rate the trader picks replaces any open Smart Rate suggestion: a later YES must not undo it. */
export function setRate(deps: Deps, merchantId: string, bps: number): Merchant {
  const m = setRateBps(deps.db, merchantId, bps);
  deps.db.prepare(`UPDATE rate_suggestions SET status = 'SUPERSEDED', responded_at = ? WHERE merchant_id = ? AND status = 'OPEN'`).run(deps.clock().toISOString(), merchantId);
  return m;
}

export const PAUSE_HOURS = 48;
export const pause = (deps: Deps, merchantId: string, hours = PAUSE_HOURS) => pauseMerchant(deps.db, merchantId, deps.clock(), hours);
export const resume = (deps: Deps, merchantId: string) => resumeMerchant(deps.db, merchantId);
export { getMerchant };

export const maskAccount = (acct: string) => `****${acct.slice(-4)}`;
