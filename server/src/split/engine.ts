import { AppError } from '../errors';
import { maxKobo, minKobo, percentOf, type Kobo } from '../money';

/**
 * Pure sweep maths. No I/O, no clock: everything here is deterministic and unit-tested.
 *
 *   sweep      = min( floor(takings x rate%), daily_cap )
 *   emergency  = floor(sweep / 2)
 *   retirement = sweep - emergency          (an odd kobo always goes to retirement)
 */
export interface Split {
  emergency: Kobo;
  retirement: Kobo;
}

export function splitSweep(sweep: Kobo): Split {
  if (sweep <= 0n) throw new AppError('INVALID_AMOUNT', 'Sweep amount must be greater than zero.', 400);
  const emergency = sweep / 2n;
  return { emergency, retirement: sweep - emergency };
}

export function computeSweepAmount(args: { takings: Kobo; rateHundredths: bigint; dailyCap: Kobo }): {
  sweep: Kobo;
  uncapped: Kobo;
  capApplied: boolean;
} {
  const uncapped = percentOf(args.takings, args.rateHundredths);
  const sweep = minKobo(uncapped, args.dailyCap);
  return { sweep, uncapped, capApplied: sweep < uncapped };
}

/** Never leave the merchant below the working-capital buffer: shrink the sweep (to zero if need be). */
export function applyBuffer(args: { sweep: Kobo; balance: Kobo; buffer: Kobo }): Kobo {
  return maxKobo(0n, minKobo(args.sweep, args.balance - args.buffer));
}
