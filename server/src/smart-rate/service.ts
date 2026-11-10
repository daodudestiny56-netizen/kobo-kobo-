import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps';
import { tx } from '../db';
import { AppError } from '../errors';
import { addMessage } from '../messages/service';
import * as T from '../messages/templates';
import { assertRate, getMerchant, setRateBps } from '../merchants/service';
import { rateDisplay } from '../money';

/**
 * SmartRate suggestions (PRD 9.2). Tomiwa's statistics decide WHAT to suggest and call createSuggestion; this
 * module owns the trader's confirmation: a rate changes only on an explicit YES (SMS) or accept (app).
 * One open suggestion per trader, 72 hours to answer, 14 days of quiet after a NO.
 */
const EXPIRY_HOURS = 72;
const COOLDOWN_DAYS = 14;
const iso = (d: Date) => d.toISOString();

export function createSuggestion(deps: Deps, a: { merchantId: string; suggestedBps: number; reason?: string }): { id: string } {
  assertRate(a.suggestedBps);
  const m = getMerchant(deps.db, a.merchantId);
  const now = deps.clock();
  if (m.rateBps === a.suggestedBps) throw new AppError('RATE_UNCHANGED', 'The suggested rate equals the current rate.', 422);
  return tx(deps.db, () => {
    expireStale(deps);
    const declined = deps.db.prepare(`SELECT responded_at r FROM rate_suggestions WHERE merchant_id = ? AND status = 'DECLINED' ORDER BY responded_at DESC LIMIT 1`).get(m.id) as { r: string } | undefined;
    if (declined && now.getTime() - new Date(declined.r).getTime() < COOLDOWN_DAYS * 86_400_000) {
      throw new AppError('SUGGESTION_COOLDOWN', 'The trader recently said no. Try again later.', 409, { retry_after: iso(new Date(new Date(declined.r).getTime() + COOLDOWN_DAYS * 86_400_000)) });
    }
    if (deps.db.prepare(`SELECT 1 FROM rate_suggestions WHERE merchant_id = ? AND status = 'OPEN'`).get(m.id)) {
      throw new AppError('SUGGESTION_PENDING', 'A suggestion is already waiting for this trader.', 409);
    }
    const id = randomUUID();
    deps.db.prepare(`INSERT INTO rate_suggestions (id, merchant_id, current_bps, suggested_bps, reason, expires_at, created_at) VALUES (?,?,?,?,?,?,?)`).run(
      id, m.id, m.rateBps, a.suggestedBps, a.reason ?? null, iso(new Date(now.getTime() + EXPIRY_HOURS * 3_600_000)), iso(now),
    );
    addMessage(deps.db, { merchantId: m.id, kind: 'RATE_SUGGESTION', language: m.language, dedupeKey: `suggest:${id}`, at: now, body: T.rateSuggestion(m.language, { current: rateDisplay(BigInt(m.rateBps)), suggested: rateDisplay(BigInt(a.suggestedBps)) }) });
    return { id };
  });
}

export function expireStale(deps: Deps): void {
  const now = iso(deps.clock());
  deps.db.prepare(`UPDATE rate_suggestions SET status = 'EXPIRED', responded_at = ? WHERE status = 'OPEN' AND expires_at <= ?`).run(now, now);
}

export function getOpenSuggestion(deps: Deps, merchantId: string) {
  expireStale(deps);
  const r = deps.db.prepare(`SELECT * FROM rate_suggestions WHERE merchant_id = ? AND status = 'OPEN'`).get(merchantId) as any;
  return r ? { id: r.id as string, currentBps: r.current_bps as number, suggestedBps: r.suggested_bps as number, reason: r.reason as string | null, expiresAt: r.expires_at as string } : null;
}

export type SuggestionResponse = { outcome: 'NONE' } | { outcome: 'ACCEPTED' | 'DECLINED'; bps: number };

export function respondToSuggestion(deps: Deps, a: { merchantId: string; decision: 'ACCEPT' | 'DECLINE' }): SuggestionResponse {
  return tx(deps.db, () => {
    const s = getOpenSuggestion(deps, a.merchantId);
    if (!s) return { outcome: 'NONE' };
    const now = iso(deps.clock());
    if (a.decision === 'ACCEPT') {
      setRateBps(deps.db, a.merchantId, s.suggestedBps);
      deps.db.prepare(`UPDATE rate_suggestions SET status = 'ACCEPTED', responded_at = ? WHERE id = ?`).run(now, s.id);
      return { outcome: 'ACCEPTED', bps: s.suggestedBps };
    }
    deps.db.prepare(`UPDATE rate_suggestions SET status = 'DECLINED', responded_at = ? WHERE id = ?`).run(now, s.id);
    return { outcome: 'DECLINED', bps: s.currentBps };
  });
}
