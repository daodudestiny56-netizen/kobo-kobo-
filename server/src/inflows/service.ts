import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { toKobo, type Kobo } from '../money';
import { getMerchant } from '../merchants/service';

export interface Inflow {
  id: string;
  merchantId: string;
  eventId: string | null;
  bankReference: string;
  amount: Kobo;
  channel: string;
  counted: boolean;
  holdStatus: string | null;
  settledAt: string;
}

const map = (r: any): Inflow => ({
  id: r.id, merchantId: r.merchant_id, eventId: r.event_id, bankReference: r.bank_reference, amount: toKobo(r.amount_kobo),
  channel: r.channel, counted: r.counted === 1, holdStatus: r.hold_status, settledAt: r.settled_at,
});

/**
 * Record a customer credit on a trader's account. This is the one entry point for takings: the Forge webhook
 * receiver (Abiodun) and the demo "customer pays" button both call it, so they behave the same.
 *
 * Idempotent on `eventId` and on `bankReference`: a webhook the bank delivers twice records one credit.
 * `counted: false` is for credits that are not sales (a loan, the trader's own transfer, a reversal): they are stored
 * but never swept.
 */
export function recordInflow(
  deps: Deps,
  a: { merchantId: string; amount: Kobo; channel?: string; eventId?: string; bankReference?: string; settledAt?: Date; counted?: boolean },
): { inflow: Inflow; duplicate: boolean } {
  if (a.amount <= 0n) throw new AppError('INVALID_AMOUNT', 'A credit must be greater than zero.', 422);
  getMerchant(deps.db, a.merchantId); // 404 for an unknown trader
  const now = deps.clock();
  const ref = a.bankReference ?? `IN-${randomUUID()}`;
  const r = deps.db
    .prepare(
      `INSERT OR IGNORE INTO inflows (id, merchant_id, event_id, bank_reference, amount_kobo, channel, counted, settled_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), a.merchantId, a.eventId ?? null, ref, a.amount, a.channel ?? 'NIP_TRANSFER', a.counted === false ? 0 : 1, (a.settledAt ?? now).toISOString(), now.toISOString());
  const row = deps.db.prepare('SELECT * FROM inflows WHERE bank_reference = ? OR (event_id IS NOT NULL AND event_id = ?)').get(ref, a.eventId ?? null);
  return { inflow: map(row), duplicate: r.changes === 0 };
}

export function listInflows(deps: Deps, merchantId: string, limit = 50): Inflow[] {
  return (deps.db.prepare('SELECT * FROM inflows WHERE merchant_id = ? ORDER BY settled_at DESC, rowid DESC LIMIT ?').all(merchantId, limit) as any[]).map(map);
}
