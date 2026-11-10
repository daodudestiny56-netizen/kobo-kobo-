import type { Deps } from '../deps';
import type { Queryable } from '../db/pool';
import { dbToKobo, rateToHundredths, type Kobo } from '../money';
import { normalizePhone } from '../phone';
import { computeSweepAmount } from '../split/engine';
import { isEffectivelyPaused, loadSweep, windowInflows, type SweepRecord } from '../sweeps/service';
import { currentSweepDate } from '../time';

/**
 * Things a trader can do from a feature phone, shared by USSD and two-way SMS so both behave identically.
 * Pause and rate changes write exactly the columns the nightly sweep reads:
 * merchants.is_paused, merchants.paused_until, merchants.sweep_percentage.
 */
export interface ChannelMerchant {
  id: string;
  phone_number: string;
  full_name: string;
  preferred_language: string;
  access_nuban: string;
  sweep_percentage: string;
  daily_cap: string;
  is_paused: boolean;
  paused_until: Date | null;
  has_pin: boolean;
}

export async function findMerchantByPhone(db: Queryable, raw: string): Promise<ChannelMerchant | null> {
  const phone = normalizePhone(raw);
  if (!phone) return null;
  const { rows } = await db.query<ChannelMerchant>(
    `SELECT id, phone_number, full_name, preferred_language, access_nuban, sweep_percentage::text, daily_cap::text, is_paused, paused_until, pin_hash IS NOT NULL AS has_pin
       FROM merchants WHERE phone_number = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

/** "3", "2.5", "3%" -> hundredths of a percent; null unless it is between 1 and 5 inclusive. */
export function parseRate(input: string): bigint | null {
  const s = input.trim().replace(/%$/, '');
  if (!/^\d(\.\d{1,2})?$/.test(s)) return null;
  const h = rateToHundredths(s);
  return h >= 100n && h <= 500n ? h : null;
}

export async function setSweepRate(db: Queryable, merchantId: string, hundredths: bigint): Promise<void> {
  const rate = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
  await db.query('UPDATE merchants SET sweep_percentage = $2, updated_at = now() WHERE id = $1', [merchantId, rate]);
  // A rate the trader picked themselves replaces any open Smart Rate suggestion: a later "YES" must not undo it.
  await db.query(`UPDATE rate_suggestions SET status = 'SUPERSEDED', responded_at = now() WHERE merchant_id = $1 AND status = 'PENDING'`, [merchantId]);
}

export const PAUSE_HOURS = 48;

/** Pause the nightly sweep for 48 hours (inventory-buying days). Returns when the pause lapses. */
export async function pauseSweeps(deps: Deps, merchantId: string, hours = PAUSE_HOURS): Promise<Date> {
  const until = new Date(deps.clock().getTime() + hours * 3_600_000);
  await deps.db.query('UPDATE merchants SET is_paused = TRUE, paused_until = $2, updated_at = now() WHERE id = $1', [merchantId, until]);
  return until;
}

export async function resumeSweeps(db: Queryable, merchantId: string): Promise<void> {
  await db.query('UPDATE merchants SET is_paused = FALSE, paused_until = NULL, updated_at = now() WHERE id = $1', [merchantId]);
}

export const isPausedNow = (m: ChannelMerchant, now: Date) => isEffectivelyPaused(m, now);

export interface TodaySummary {
  sweepDate: string;
  takings: Kobo;
  /** What tonight's sweep will be at the current rate and cap (before the buffer check). */
  projected: Kobo;
  record: SweepRecord | null;
}

/** Takings in the window that closes at the next 23:00 WAT, and what the sweep will be. */
export async function todaySummary(deps: Deps, m: ChannelMerchant): Promise<TodaySummary> {
  const sweepDate = currentSweepDate(deps.clock());
  const [{ total }, record] = await Promise.all([windowInflows(deps.db, m.id, sweepDate), loadSweep(deps.db, m.id, sweepDate)]);
  const { sweep } = computeSweepAmount({ takings: total, rateHundredths: rateToHundredths(m.sweep_percentage), dailyCap: dbToKobo(m.daily_cap) });
  return { sweepDate, takings: total, projected: sweep, record };
}
