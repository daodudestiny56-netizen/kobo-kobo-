import { tx, type Db } from '../db';
import { AppError } from '../errors';

export interface GuardAlert {
  id: string;
  merchantId: string;
  inflowId: string | null;
  sweepId: string | null;
  type: string;
  details: unknown;
  status: 'PENDING_REVIEW' | 'DISMISSED' | 'CONFIRMED';
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
}

const map = (r: any): GuardAlert => ({
  id: r.id, merchantId: r.merchant_id, inflowId: r.inflow_id, sweepId: r.sweep_id, type: r.type, details: r.details ? JSON.parse(r.details) : null,
  status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, note: r.note,
});

export function listAlerts(db: Db, status?: GuardAlert['status']): GuardAlert[] {
  const rows = status
    ? db.prepare('SELECT * FROM guard_alerts WHERE status = ? ORDER BY created_at DESC, rowid DESC').all(status)
    : db.prepare('SELECT * FROM guard_alerts ORDER BY created_at DESC, rowid DESC').all();
  return (rows as any[]).map(map);
}

/**
 * Ops review of a held credit (PRD 9.1).
 *  DISMISS: the credit was fine. It counts from now, so it lands in the next sweep window.
 *  CONFIRM: the flag was right. The credit is excluded from takings for good.
 */
export function resolveAlert(db: Db, id: string, action: 'DISMISS' | 'CONFIRM', by: string, note: string | null, now: Date): GuardAlert {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM guard_alerts WHERE id = ?').get(id) as any;
    if (!row) throw new AppError('ALERT_NOT_FOUND', 'No such alert.', 404);
    if (row.status !== 'PENDING_REVIEW') throw new AppError('ALERT_ALREADY_RESOLVED', `Alert is already ${row.status}.`, 409);
    const status = action === 'DISMISS' ? 'DISMISSED' : 'CONFIRMED';
    db.prepare('UPDATE guard_alerts SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?').run(status, now.toISOString(), by, note, id);
    if (row.inflow_id) {
      db.prepare('UPDATE inflows SET hold_status = ?, released_at = ? WHERE id = ?').run(status, action === 'DISMISS' ? now.toISOString() : null, row.inflow_id);
    }
    return map(db.prepare('SELECT * FROM guard_alerts WHERE id = ?').get(id));
  });
}
