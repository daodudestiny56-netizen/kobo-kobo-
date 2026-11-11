import type { Deps } from '../deps';
import { AppError } from '../errors';
import { suggestRate } from '../intel/smartrate';
import type { PastSuggestion, SmartRateResult } from '../intel/types';
import { getMerchant, isPaused, listActiveMerchants } from '../merchants/service';
import { addDays, sweepCutoff, sweepDateOf, toWatDate, upcomingSweepDate } from '../time';
import { createSuggestion } from './service';

/**
 * Runs SmartRate for a trader from their own history and, when it recommends a change, files a suggestion. The trader
 * still has to say YES: this never changes a rate by itself. "asOf" is the last sweep day that is fully over.
 */
export interface SmartRateRun {
  merchantId: string;
  result: SmartRateResult;
  suggestionId: string | null;
  /** Why a recommended change was not filed (an open suggestion, a recent NO, an unchanged rate). */
  skipped: string | null;
}

const STATUS: Record<string, PastSuggestion['status']> = { OPEN: 'PENDING', ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED', EXPIRED: 'EXPIRED' };

export function analyzeMerchant(deps: Deps, merchantId: string, opts: { file?: boolean } = {}): SmartRateRun {
  const m = getMerchant(deps.db, merchantId);
  const now = deps.clock();
  const asOf = addDays(upcomingSweepDate(now), -1);

  const rows = deps.db
    .prepare(
      `SELECT settled_at, amount_kobo FROM inflows
        WHERE merchant_id = ? AND counted = 1 AND (hold_status IS NULL OR hold_status = 'DISMISSED') AND settled_at >= ? AND settled_at < ?`,
    )
    .all(m.id, sweepCutoff(addDays(asOf, -61)).toISOString(), sweepCutoff(addDays(asOf, 1)).toISOString()) as { settled_at: string; amount_kobo: number | bigint }[];
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = sweepDateOf(new Date(r.settled_at));
    byDay.set(day, (byDay.get(day) ?? 0) + Number(r.amount_kobo));
  }
  const firstTakingDay = [...byDay.keys()].sort()[0];
  const created = toWatDate(m.createdAt);
  const firstDay = firstTakingDay && firstTakingDay < created ? firstTakingDay : created;

  const suggestions = deps.db
    .prepare('SELECT current_bps, suggested_bps, status, created_at, responded_at, expires_at FROM rate_suggestions WHERE merchant_id = ? ORDER BY created_at')
    .all(m.id) as { current_bps: number; suggested_bps: number; status: string; created_at: string; responded_at: string | null; expires_at: string }[];

  const result = suggestRate({
    merchantId: m.id,
    asOf,
    firstDay,
    currentRate: m.rateBps / 100,
    takings: [...byDay].map(([day, amountKobo]) => ({ day, amountKobo })),
    isPaused: isPaused(m, now),
    dailyCapKobo: Number(m.dailyCap),
    recentSuggestions: suggestions.map((s) => ({
      createdAt: s.created_at,
      direction: s.suggested_bps > s.current_bps ? 'INCREASE' : 'DECREASE',
      status: STATUS[s.status] ?? 'EXPIRED',
      respondedAt: s.responded_at ?? undefined,
      expiresAt: s.expires_at,
    })),
    now: now.toISOString(),
  });

  if (result.action === 'HOLD' || opts.file === false) return { merchantId: m.id, result, suggestionId: null, skipped: null };
  try {
    const { id } = createSuggestion(deps, { merchantId: m.id, suggestedBps: Math.round(result.recommendedRate * 100), reason: result.rationale.slice(0, 500) });
    return { merchantId: m.id, result, suggestionId: id, skipped: null };
  } catch (e) {
    if (e instanceof AppError && e.status < 500) return { merchantId: m.id, result, suggestionId: null, skipped: e.code };
    throw e;
  }
}

/** Every active trader. One trader failing never stops the others. */
export function runSmartRate(deps: Deps): SmartRateRun[] {
  const out: SmartRateRun[] = [];
  for (const m of listActiveMerchants(deps.db)) {
    try {
      out.push(analyzeMerchant(deps, m.id));
    } catch (e) {
      console.error(`[smart-rate] ${m.id}:`, (e as Error).message);
    }
  }
  return out;
}
