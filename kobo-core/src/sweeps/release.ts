import type { Deps } from '../deps';
import { withTx } from '../db/pool';
import { AppError } from '../errors';
import { ExecutorError } from '../executors/types';
import { dbToKobo, koboToNaira, nairaDisplay, rateToHundredths } from '../money';
import { reservePenReference } from '../pfa/simulator';
import { enqueueSms } from '../sms/outbox';
import { bufferSkipped, guardBlockedNotice, guardReleasedNotice } from '../sms/templates';
import { applyBuffer, computeSweepAmount, splitSweep } from '../split/engine';
import { addDays, toWatDate } from '../time';
import { debitAndSettle, isEffectivelyPaused, loadMerchant, loadSweep, mapSweep, SWEEP_COLS, windowInflows, type SweepRecord } from './service';

export type AlertDecision = 'RELEASE' | 'CONFIRM';

export interface GuardAlert {
  id: string;
  merchantId: string;
  sweepId: string | null;
  alertType: string;
  status: 'PENDING_REVIEW' | 'DISMISSED' | 'CONFIRMED';
  details: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedVia: string | null;
  resolutionNote: string | null;
}

const ALERT_COLS = `id, merchant_id, sweep_id, alert_type, status, details, created_at, resolved_at, resolved_by, resolved_via, resolution_note`;
const mapAlert = (r: Record<string, any>): GuardAlert => ({
  id: r.id,
  merchantId: r.merchant_id,
  sweepId: r.sweep_id,
  alertType: r.alert_type,
  status: r.status,
  details: r.details,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  resolvedBy: r.resolved_by,
  resolvedVia: r.resolved_via,
  resolutionNote: r.resolution_note,
});

export async function listAlerts(deps: Deps, f: { status?: string; merchantId?: string; limit?: number }): Promise<(GuardAlert & { sweepDate: string | null; sweepStatus: string | null })[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.status) where.push(`a.status = $${params.push(f.status)}`);
  if (f.merchantId) where.push(`a.merchant_id = $${params.push(f.merchantId)}`);
  params.push(Math.min(f.limit ?? 100, 500));
  const { rows } = await deps.db.query(
    `SELECT ${ALERT_COLS.split(', ').map((c) => `a.${c}`).join(', ')}, to_char(s.sweep_date,'YYYY-MM-DD') AS sweep_date, s.status AS sweep_status
       FROM sweep_guard_alerts a LEFT JOIN daily_sweeps s ON s.id = a.sweep_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...mapAlert(r), sweepDate: r.sweep_date, sweepStatus: r.sweep_status }));
}

export interface ResolveInput {
  alertId: string;
  decision: AlertDecision;
  resolvedBy: string;
  via: 'OPS' | 'SMS';
  note?: string;
}
export interface ResolveResult {
  alert: GuardAlert;
  sweep: SweepRecord;
  /** True when this call changed something; false when the same decision had already been applied. */
  changed: boolean;
}

/**
 * Resolve a Sweep Guard hold.
 *  RELEASE: the sweep is re-planned from the CURRENT facts (pause, takings, rate, buffer), moved to PENDING and debited with the
 *           normal idempotent flow, so a released sweep gets the same safety as any other. Alert -> DISMISSED.
 *  CONFIRM: the anomaly is real; the sweep stays unswept (HELD_GUARD, reason GUARD_CONFIRMED). Alert -> CONFIRMED.
 * Traders may self-release only ANOMALOUS_INFLOW holds (a big sale is theirs to vouch for); duplicates and name mismatches need ops.
 * Idempotent: repeating the same decision returns the settled outcome.
 */
export async function resolveGuardAlert(deps: Deps, a: ResolveInput): Promise<ResolveResult> {
  const found = await deps.db.query(`SELECT ${ALERT_COLS} FROM sweep_guard_alerts WHERE id = $1`, [a.alertId]);
  if (!found.rows[0]) throw new AppError('ALERT_NOT_FOUND', 'No such alert.', 404);
  const alert0 = mapAlert(found.rows[0]);
  if (!alert0.sweepId) throw new AppError('ALERT_NOT_ACTIONABLE', 'This alert is not attached to a held sweep.', 422);

  const sweepRow = await deps.db.query(`SELECT ${SWEEP_COLS} FROM daily_sweeps WHERE id = $1`, [alert0.sweepId]);
  const sweep0 = mapSweep(sweepRow.rows[0]);

  if (alert0.status !== 'PENDING_REVIEW') {
    const same = (alert0.status === 'DISMISSED') === (a.decision === 'RELEASE');
    if (!same) throw new AppError('ALERT_ALREADY_RESOLVED', `Alert was already ${alert0.status}.`, 409, { status: alert0.status });
    return { alert: alert0, sweep: sweep0, changed: false };
  }
  if (sweep0.status !== 'HELD_GUARD') throw new AppError('ALERT_NOT_ACTIONABLE', `The sweep is ${sweep0.status}, not held.`, 422);
  if (a.via === 'SMS' && alert0.alertType !== 'ANOMALOUS_INFLOW') {
    throw new AppError('NOT_SELF_RELEASABLE', 'This hold needs a review by our team.', 403);
  }
  const lastDay = addDays(sweep0.sweepDate, deps.config.guard.releaseWindowDays);
  if (a.decision === 'RELEASE' && toWatDate(deps.clock()) > lastDay) {
    throw new AppError('RELEASE_WINDOW_PASSED', `Held sweeps can be released for ${deps.config.guard.releaseWindowDays} days after the sweep date.`, 409, { sweep_date: sweep0.sweepDate });
  }

  const merchant = await loadMerchant(deps.db, alert0.merchantId);
  const now = deps.clock();
  const mark = (c: { query: Function }, status: 'DISMISSED' | 'CONFIRMED') =>
    c.query(`UPDATE sweep_guard_alerts SET status = $2, resolved_at = $3, resolved_by = $4, resolved_via = $5, resolution_note = $6 WHERE id = $1`, [a.alertId, status, now, a.resolvedBy, a.via, a.note ?? null]);

  if (a.decision === 'CONFIRM') {
    const sweep = await withTx(deps.db, async (c) => {
      const lock = await c.query(`SELECT status FROM sweep_guard_alerts WHERE id = $1 FOR UPDATE`, [a.alertId]);
      if (lock.rows[0].status !== 'PENDING_REVIEW') return null;
      await mark(c, 'CONFIRMED');
      await c.query(`UPDATE daily_sweeps SET failure_reason = $2 WHERE id = $1`, [alert0.sweepId, `GUARD_CONFIRMED:${alert0.alertType}`]);
      await enqueueSms(c, { merchantId: merchant.id, to: merchant.phone_number, kind: 'GUARD', dedupeKey: `guard-blocked:${a.alertId}`, at: now, body: guardBlockedNotice(merchant.preferred_language) });
      return (await loadSweep(c, merchant.id, sweep0.sweepDate))!;
    });
    return resolveAgain(deps, a, sweep);
  }

  // RELEASE. Ask the bank for the balance first (it may fail retryably; nothing has changed yet).
  let balance;
  try {
    balance = await deps.executor.getBalance(merchant.access_nuban);
  } catch (e) {
    if (e instanceof ExecutorError) throw new AppError('EXECUTOR_UNAVAILABLE', 'The bank could not be reached. Try again shortly.', 503);
    throw e;
  }

  const planned = await withTx(deps.db, async (c) => {
    const lock = await c.query(`SELECT status FROM sweep_guard_alerts WHERE id = $1 FOR UPDATE`, [a.alertId]);
    if (lock.rows[0].status !== 'PENDING_REVIEW') return null; // someone else resolved it first
    const m = await loadMerchant(c, merchant.id);
    const { total } = await windowInflows(c, m.id, sweep0.sweepDate);
    const rate = rateToHundredths(m.sweep_percentage);
    const { sweep } = computeSweepAmount({ takings: total, rateHundredths: rate, dailyCap: dbToKobo(m.daily_cap) });
    const buffer = dbToKobo(m.min_buffer_balance);
    const adjusted = sweep === 0n ? 0n : applyBuffer({ sweep, balance, buffer });

    let status: 'PENDING' | 'SKIPPED_PAUSED' | 'SKIPPED_ZERO_SALES' | 'SKIPPED_BUFFER' = 'PENDING';
    let reason: string | null = null;
    if (isEffectivelyPaused(m, now)) status = 'SKIPPED_PAUSED';
    else if (total === 0n || sweep === 0n) status = 'SKIPPED_ZERO_SALES';
    else if (adjusted === 0n) {
      status = 'SKIPPED_BUFFER';
      reason = `BUFFER: balance ${koboToNaira(balance)}, buffer ${koboToNaira(buffer)}`;
    }

    const split = status === 'PENDING' ? splitSweep(adjusted) : { emergency: 0n, retirement: 0n };
    const ref = status === 'PENDING' ? await reservePenReference(c, m.id, sweep0.sweepDate) : null;
    await c.query(
      `UPDATE daily_sweeps SET status = $2, total_takings = $3, applied_rate = $4, sweep_amount = $5, emergency_amount = $6,
              retirement_amount = $7, pension_reference = $8, failure_reason = $9, last_error = NULL, attempts = 0 WHERE id = $1`,
      [alert0.sweepId, status, koboToNaira(total), koboToNaira(rate), koboToNaira(status === 'PENDING' ? adjusted : 0n), koboToNaira(status === 'PENDING' ? split.emergency : 0n), koboToNaira(status === 'PENDING' ? split.retirement : 0n), ref, reason],
    );
    await mark(c, 'DISMISSED');
    if (status === 'SKIPPED_BUFFER') {
      await enqueueSms(c, { merchantId: m.id, to: m.phone_number, kind: 'SWEEP_SKIPPED', dedupeKey: `sweep_skipped:${alert0.sweepId}`, at: now, body: bufferSkipped(m.preferred_language, { buffer: nairaDisplay(buffer) }) });
    } else if (status === 'PENDING' && a.via === 'OPS') {
      await enqueueSms(c, { merchantId: m.id, to: m.phone_number, kind: 'GUARD', dedupeKey: `guard-released:${a.alertId}`, at: now, body: guardReleasedNotice(m.preferred_language) });
    }
    return (await loadSweep(c, m.id, sweep0.sweepDate))!;
  });

  const sweep = planned && planned.status === 'PENDING' ? await debitAndSettle(deps, planned) : planned;
  return resolveAgain(deps, a, sweep);
}

async function resolveAgain(deps: Deps, a: ResolveInput, sweep: SweepRecord | null): Promise<ResolveResult> {
  const { rows } = await deps.db.query(`SELECT ${ALERT_COLS} FROM sweep_guard_alerts WHERE id = $1`, [a.alertId]);
  const alert = mapAlert(rows[0]);
  const current = sweep ?? (await loadSweep(deps.db, alert.merchantId, (await deps.db.query(`SELECT to_char(sweep_date,'YYYY-MM-DD') d FROM daily_sweeps WHERE id = $1`, [alert.sweepId])).rows[0].d))!;
  return { alert, sweep: current, changed: sweep !== null };
}

/**
 * Sweeps left PENDING on a past date (the nightly job only looks at "today") are resumed here with the same
 * idempotency key. Covers released holds whose debit hit a bank outage. Returns how many were attempted.
 */
export async function resumeStalePendingSweeps(deps: Deps): Promise<number> {
  const today = toWatDate(deps.clock());
  const { rows } = await deps.db.query(`SELECT ${SWEEP_COLS} FROM daily_sweeps WHERE status = 'PENDING' AND sweep_date < $1 ORDER BY sweep_date LIMIT 100`, [today]);
  for (const r of rows) {
    try {
      await debitAndSettle(deps, mapSweep(r));
    } catch (e) {
      console.error(`[sweeps] resume of ${r.id} failed:`, (e as Error).message);
    }
  }
  return rows.length;
}
