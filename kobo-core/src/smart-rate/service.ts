import type { Deps } from '../deps';
import { withTx } from '../db/pool';
import { AppError } from '../errors';
import { rateDisplay, rateToHundredths } from '../money';
import { setSweepRate } from '../channels/actions';
import { enqueueSms } from '../sms/outbox';
import { rateSuggestion, suggestionAccepted, suggestionDeclined } from '../sms/templates';
import { addDaysToInstant } from '../time';

export type SuggestionStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'SUPERSEDED';

export interface RateSuggestion {
  id: string;
  merchantId: string;
  currentRate: bigint;
  suggestedRate: bigint;
  reason: string | null;
  status: SuggestionStatus;
  respondedVia: string | null;
  createdAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
}

const COLS = `id, merchant_id, current_rate::text AS current_rate, suggested_rate::text AS suggested_rate, reason, status, responded_via, created_at, expires_at, responded_at`;
const map = (r: Record<string, any>): RateSuggestion => ({
  id: r.id,
  merchantId: r.merchant_id,
  currentRate: rateToHundredths(r.current_rate),
  suggestedRate: rateToHundredths(r.suggested_rate),
  reason: r.reason,
  status: r.status,
  respondedVia: r.responded_via,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  respondedAt: r.responded_at,
});
const fmt = (h: bigint) => `${h / 100n}.${(h % 100n).toString().padStart(2, '0')}`;

/** Mark suggestions past their expiry as EXPIRED. Called lazily and by the scheduler. Returns how many. */
export async function expireStaleSuggestions(deps: Deps): Promise<number> {
  const r = await deps.db.query(`UPDATE rate_suggestions SET status = 'EXPIRED', responded_at = $1 WHERE status = 'PENDING' AND expires_at <= $1`, [deps.clock()]);
  return r.rowCount ?? 0;
}

export async function getPendingSuggestion(deps: Deps, merchantId: string): Promise<RateSuggestion | null> {
  await expireStaleSuggestions(deps);
  const { rows } = await deps.db.query(`SELECT ${COLS} FROM rate_suggestions WHERE merchant_id = $1 AND status = 'PENDING'`, [merchantId]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The Smart Rate engine proposes a new rate. This NEVER changes merchants.sweep_percentage: it records the
 * suggestion and texts the trader, and only an explicit YES (SMS) or an accept from the app applies it.
 * Guard rails: 1-5%, must differ from the current rate, one open suggestion at a time, and after a "NO"
 * we stay quiet for `declineCooldownDays`.
 */
export async function createSuggestion(deps: Deps, a: { merchantId: string; suggestedRate: bigint; reason?: string }): Promise<RateSuggestion> {
  if (a.suggestedRate < 100n || a.suggestedRate > 500n) throw new AppError('INVALID_RATE', 'Suggested rate must be between 1% and 5%.', 400);
  const now = deps.clock();
  await expireStaleSuggestions(deps);

  return withTx(deps.db, async (c) => {
    const m = await c.query('SELECT phone_number, preferred_language, sweep_percentage::text AS rate FROM merchants WHERE id = $1 FOR UPDATE', [a.merchantId]);
    if (!m.rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);
    const current = rateToHundredths(m.rows[0].rate);
    if (current === a.suggestedRate) throw new AppError('RATE_UNCHANGED', 'The suggested rate equals the current rate.', 422);

    const open = await c.query(`SELECT id FROM rate_suggestions WHERE merchant_id = $1 AND status = 'PENDING'`, [a.merchantId]);
    if (open.rows[0]) throw new AppError('SUGGESTION_PENDING', 'This trader already has an open suggestion.', 409, { suggestion_id: open.rows[0].id });

    const since = addDaysToInstant(now, -deps.config.smartRate.declineCooldownDays);
    const declined = await c.query(`SELECT responded_at FROM rate_suggestions WHERE merchant_id = $1 AND status = 'DECLINED' AND responded_at > $2 LIMIT 1`, [a.merchantId, since]);
    if (declined.rows[0]) {
      throw new AppError('SUGGESTION_COOLDOWN', 'The trader declined a suggestion recently.', 409, {
        retry_after: addDaysToInstant(declined.rows[0].responded_at, deps.config.smartRate.declineCooldownDays).toISOString(),
      });
    }

    const expires = new Date(now.getTime() + deps.config.smartRate.expiryHours * 3_600_000);
    const ins = await c.query(
      `INSERT INTO rate_suggestions (merchant_id, current_rate, suggested_rate, reason, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
      [a.merchantId, fmt(current), fmt(a.suggestedRate), a.reason ?? null, now, expires],
    );
    const s = map(ins.rows[0]);
    await enqueueSms(c, {
      merchantId: a.merchantId,
      to: m.rows[0].phone_number,
      kind: 'SMART_RATE',
      dedupeKey: `rate-suggestion:${s.id}`,
      at: now,
      body: rateSuggestion(m.rows[0].preferred_language, { current: rateDisplay(current), suggested: rateDisplay(a.suggestedRate) }),
    });
    return s;
  });
}

export type ResponseOutcome = { outcome: 'ACCEPTED'; rate: bigint; suggestion: RateSuggestion } | { outcome: 'DECLINED'; rate: bigint; suggestion: RateSuggestion } | { outcome: 'NONE' };

/**
 * The trader's answer. ACCEPT writes the new rate (the field the sweep reads) in the same transaction that marks the
 * suggestion ACCEPTED. With nothing open (or an expired one) the outcome is NONE and nothing changes.
 * `via` records where the answer came from; `suggestionId` pins an app tap to the suggestion the trader was shown.
 */
export async function respondToSuggestion(
  deps: Deps,
  a: { merchantId: string; decision: 'ACCEPT' | 'DECLINE'; via: 'SMS' | 'APP'; suggestionId?: string },
): Promise<ResponseOutcome> {
  await expireStaleSuggestions(deps);
  const now = deps.clock();
  return withTx(deps.db, async (c) => {
    const sel = await c.query(
      `SELECT ${COLS} FROM rate_suggestions WHERE merchant_id = $1 AND status = 'PENDING' ${a.suggestionId ? 'AND id = $2' : ''} FOR UPDATE`,
      a.suggestionId ? [a.merchantId, a.suggestionId] : [a.merchantId],
    );
    if (!sel.rows[0]) return { outcome: 'NONE' as const };
    const s = map(sel.rows[0]);
    const status = a.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
    const upd = await c.query(`UPDATE rate_suggestions SET status = $2, responded_via = $3, responded_at = $4 WHERE id = $1 RETURNING ${COLS}`, [s.id, status, a.via, now]);
    const m = await c.query('SELECT phone_number, preferred_language, sweep_percentage::text AS rate FROM merchants WHERE id = $1', [a.merchantId]);
    let rate = rateToHundredths(m.rows[0].rate);
    if (a.decision === 'ACCEPT') {
      await setSweepRate(c, a.merchantId, s.suggestedRate); // marked ACCEPTED first, so it does not supersede itself
      rate = s.suggestedRate;
    }
    if (a.via === 'APP') {
      await enqueueSms(c, {
        merchantId: a.merchantId,
        to: m.rows[0].phone_number,
        kind: 'SMART_RATE',
        dedupeKey: `rate-suggestion-reply:${s.id}`,
        at: now,
        body: a.decision === 'ACCEPT' ? suggestionAccepted(m.rows[0].preferred_language, { rate: rateDisplay(rate) }) : suggestionDeclined(m.rows[0].preferred_language, { rate: rateDisplay(rate) }),
      });
    }
    return { outcome: status, rate, suggestion: map(upd.rows[0]) } as ResponseOutcome;
  });
}
