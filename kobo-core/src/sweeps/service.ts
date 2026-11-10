import { AppError } from '../errors';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db/pool';
import { ExecutorError } from '../executors/types';
import { postJournal, sweepJournalLines } from '../ledger/ledger';
import {
  dbToKobo,
  koboToNaira,
  nairaDisplay,
  rateDisplay,
  rateToHundredths,
  type Kobo,
} from '../money';
import { creditContribution, reservePenReference } from '../pfa/simulator';
import { enqueueSms } from '../sms/outbox';
import { bufferSkipped, guardHeld, sweepReceipt } from '../sms/templates';
import { applyBuffer, computeSweepAmount, splitSweep } from '../split/engine';
import { sweepCutoff, sweepWindow } from '../time';
import { sleep } from '../util/async';
import type { GuardAlertType } from '../guard';

export type SweepStatus = 'PENDING' | 'EXECUTED' | 'SKIPPED_ZERO_SALES' | 'SKIPPED_PAUSED' | 'SKIPPED_BUFFER' | 'FAILED' | 'HELD_GUARD';

export interface SweepRecord {
  id: string;
  merchantId: string;
  sweepDate: string;
  status: SweepStatus;
  totalTakings: Kobo;
  rateHundredths: bigint;
  sweepAmount: Kobo;
  emergency: Kobo;
  retirement: Kobo;
  pensionReference: string | null;
  debitReference: string | null;
  failureReason: string | null;
  attempts: number;
  lastError: string | null;
  executedAt: Date | null;
}

export interface MerchantRow {
  id: string;
  phone_number: string;
  access_nuban: string;
  preferred_language: string;
  sweep_percentage: string;
  daily_cap: string;
  min_buffer_balance: string;
  is_paused: boolean;
  paused_until: Date | null;
}

export const SWEEP_COLS = `id, merchant_id, to_char(sweep_date,'YYYY-MM-DD') AS sweep_date, status, total_takings::text, applied_rate::text,
  sweep_amount::text, emergency_amount::text, retirement_amount::text, pension_reference, debit_reference, failure_reason,
  attempts, last_error, executed_at`;

export function mapSweep(r: Record<string, any>): SweepRecord {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    sweepDate: r.sweep_date,
    status: r.status,
    totalTakings: dbToKobo(r.total_takings),
    rateHundredths: rateToHundredths(r.applied_rate),
    sweepAmount: dbToKobo(r.sweep_amount),
    emergency: dbToKobo(r.emergency_amount),
    retirement: dbToKobo(r.retirement_amount),
    pensionReference: r.pension_reference,
    debitReference: r.debit_reference,
    failureReason: r.failure_reason,
    attempts: r.attempts,
    lastError: r.last_error,
    executedAt: r.executed_at,
  };
}

export async function loadSweep(db: Queryable, merchantId: string, sweepDate: string): Promise<SweepRecord | null> {
  const { rows } = await db.query(`SELECT ${SWEEP_COLS} FROM daily_sweeps WHERE merchant_id = $1 AND sweep_date = $2`, [merchantId, sweepDate]);
  return rows[0] ? mapSweep(rows[0]) : null;
}

export async function loadMerchant(db: Queryable, id: string): Promise<MerchantRow> {
  const { rows } = await db.query<MerchantRow>(
    `SELECT id, phone_number, access_nuban, preferred_language, sweep_percentage::text, daily_cap::text,
            min_buffer_balance::text, is_paused, paused_until
       FROM merchants WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);
  return rows[0];
}

export function isEffectivelyPaused(m: Pick<MerchantRow, 'is_paused' | 'paused_until'>, now: Date): boolean {
  return m.is_paused && (m.paused_until === null || m.paused_until > now);
}

export async function windowInflows(db: Queryable, merchantId: string, sweepDate: string) {
  const { from, to } = sweepWindow(sweepDate);
  const { rows } = await db.query<{ bank_reference: string; amount: string; settled_at: Date }>(
    `SELECT bank_reference, amount::text, settled_at FROM inflow_transactions
      WHERE merchant_id = $1 AND NOT is_excluded_from_sweep AND settled_at >= $2 AND settled_at < $3
      ORDER BY settled_at`,
    [merchantId, from, to],
  );
  const inflows = rows.map((r) => ({ bankReference: r.bank_reference, amount: dbToKobo(r.amount), settledAt: r.settled_at }));
  return { inflows, total: inflows.reduce((s, i) => s + i.amount, 0n) };
}

interface NewSweep {
  merchantId: string;
  sweepDate: string;
  status: SweepStatus;
  takings: Kobo;
  rateHundredths: bigint;
  sweep: Kobo;
  emergency: Kobo;
  retirement: Kobo;
  pensionReference?: string | null;
  failureReason?: string | null;
}

/** Insert a sweep row; null when (merchant, date) already has one. This is the idempotency lock. */
async function insertSweep(db: Queryable, r: NewSweep): Promise<SweepRecord | null> {
  const { rows } = await db.query(
    `INSERT INTO daily_sweeps (merchant_id, sweep_date, total_takings, applied_rate, sweep_amount, emergency_amount,
                               retirement_amount, pension_reference, status, failure_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (merchant_id, sweep_date) DO NOTHING
     RETURNING ${SWEEP_COLS}`,
    [
      r.merchantId,
      r.sweepDate,
      koboToNaira(r.takings),
      koboToNaira(r.rateHundredths), // hundredths of a percent format exactly like kobo: "2.00"
      koboToNaira(r.sweep),
      koboToNaira(r.emergency),
      koboToNaira(r.retirement),
      r.pensionReference ?? null,
      r.status,
      r.failureReason ?? null,
    ],
  );
  return rows[0] ? mapSweep(rows[0]) : null;
}

const jsonSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Record a sweep that moves no money (skipped/held), with its alert and trader SMS, in one transaction. */
async function recordTerminal(
  deps: Deps,
  merchant: MerchantRow,
  base: Pick<NewSweep, 'merchantId' | 'sweepDate' | 'takings' | 'rateHundredths'>,
  status: SweepStatus,
  o: { failureReason?: string; alert?: { type: GuardAlertType; details: Record<string, unknown> }; sms?: { kind: 'SWEEP_SKIPPED' | 'SWEEP_HELD'; body: string } } = {},
): Promise<SweepRecord> {
  return withTx(deps.db, async (c) => {
    const rec = await insertSweep(c, { ...base, status, sweep: 0n, emergency: 0n, retirement: 0n, failureReason: o.failureReason ?? null });
    if (!rec) return (await loadSweep(c, base.merchantId, base.sweepDate))!;
    if (o.alert) {
      await c.query(`INSERT INTO sweep_guard_alerts (merchant_id, sweep_id, alert_type, details) VALUES ($1,$2,$3,$4)`, [
        base.merchantId,
        rec.id,
        o.alert.type,
        jsonSafe(o.alert.details),
      ]);
    }
    if (o.sms) {
      await enqueueSms(c, {
        merchantId: merchant.id,
        to: merchant.phone_number,
        kind: o.sms.kind,
        body: o.sms.body,
        dedupeKey: `${o.sms.kind.toLowerCase()}:${rec.id}`,
        at: deps.clock(),
      });
    }
    return rec;
  });
}

/** Decide tonight's sweep for a merchant and persist the decision. Moves no money. */
async function planAndRecord(deps: Deps, merchantId: string, sweepDate: string): Promise<SweepRecord> {
  const merchant = await loadMerchant(deps.db, merchantId);
  const hasRsa = await deps.db.query('SELECT 1 FROM pension_accounts WHERE merchant_id = $1', [merchantId]);
  if (hasRsa.rowCount === 0) {
    throw new AppError('PENSION_ACCOUNT_MISSING', 'Merchant has no RSA yet. Issue one via POST /api/v1/pfa/rsa-pin.', 422);
  }

  const { inflows, total } = await windowInflows(deps.db, merchantId, sweepDate);
  const rateHundredths = rateToHundredths(merchant.sweep_percentage);
  const base = { merchantId, sweepDate, takings: total, rateHundredths };

  if (isEffectivelyPaused(merchant, deps.clock())) return recordTerminal(deps, merchant, base, 'SKIPPED_PAUSED');
  if (total === 0n) return recordTerminal(deps, merchant, base, 'SKIPPED_ZERO_SALES');

  const verdict = await deps.guard.evaluate({ merchantId, sweepDate, takings: total, inflows });
  if (verdict.verdict === 'HOLD') {
    return recordTerminal(deps, merchant, base, 'HELD_GUARD', {
      failureReason: verdict.alertType,
      alert: { type: verdict.alertType, details: verdict.details },
      sms: { kind: 'SWEEP_HELD', body: guardHeld(merchant.preferred_language, { selfRelease: verdict.alertType === 'ANOMALOUS_INFLOW' }) },
    });
  }

  const { sweep } = computeSweepAmount({ takings: total, rateHundredths, dailyCap: dbToKobo(merchant.daily_cap) });
  if (sweep === 0n) return recordTerminal(deps, merchant, base, 'SKIPPED_ZERO_SALES', { failureReason: 'SWEEP_ROUNDS_TO_ZERO' });

  const balance = await deps.executor.getBalance(merchant.access_nuban); // may throw a retryable ExecutorError: nothing recorded yet, next run retries
  const buffer = dbToKobo(merchant.min_buffer_balance);
  const adjusted = applyBuffer({ sweep, balance, buffer });
  if (adjusted === 0n) {
    return recordTerminal(deps, merchant, base, 'SKIPPED_BUFFER', {
      failureReason: `BUFFER: balance ${koboToNaira(balance)}, buffer ${koboToNaira(buffer)}`,
      alert: { type: 'LOW_BUFFER', details: { balance: koboToNaira(balance), buffer: koboToNaira(buffer), wanted: koboToNaira(sweep) } },
      sms: { kind: 'SWEEP_SKIPPED', body: bufferSkipped(merchant.preferred_language, { buffer: nairaDisplay(buffer) }) },
    });
  }

  const split = splitSweep(adjusted);
  const pensionReference = await reservePenReference(deps.db, merchantId, sweepDate);
  return (
    (await insertSweep(deps.db, { ...base, status: 'PENDING', sweep: adjusted, emergency: split.emergency, retirement: split.retirement, pensionReference })) ??
    (await loadSweep(deps.db, merchantId, sweepDate))!
  );
}

async function markFailed(deps: Deps, rec: SweepRecord, reason: string, detail: string | null): Promise<SweepRecord> {
  const { rows } = await deps.db.query(
    `UPDATE daily_sweeps SET status = 'FAILED', failure_reason = $2, last_error = $3 WHERE id = $1 AND status = 'PENDING' RETURNING ${SWEEP_COLS}`,
    [rec.id, reason, detail],
  );
  return rows[0] ? mapSweep(rows[0]) : (await loadSweep(deps.db, rec.merchantId, rec.sweepDate))!;
}

/**
 * Post the ledger journal, credit the pots, mark the sweep EXECUTED and queue the SMS receipt, all in one
 * transaction. Idempotent: an already-EXECUTED sweep is returned untouched.
 */
export async function finalizeSweep(deps: Deps, sweepId: string, debitReference: string): Promise<{ record: SweepRecord; already: boolean }> {
  return withTx(deps.db, async (c) => {
    const locked = await c.query(`SELECT ${SWEEP_COLS} FROM daily_sweeps WHERE id = $1 FOR UPDATE`, [sweepId]);
    if (!locked.rows[0]) throw new AppError('SWEEP_NOT_FOUND', 'No such sweep.', 404);
    const rec = mapSweep(locked.rows[0]);
    if (rec.status === 'EXECUTED') return { record: rec, already: true };
    if (rec.status !== 'PENDING') {
      throw new AppError('SWEEP_STATE_CONFLICT', `Cannot settle a sweep that is ${rec.status}.`, 409, { status: rec.status });
    }

    const merchant = await loadMerchant(c, rec.merchantId);
    const split = { emergency: rec.emergency, retirement: rec.retirement };
    await postJournal(c, { merchantId: rec.merchantId, sweepId: rec.id, reference: rec.pensionReference!, lines: sweepJournalLines(rec.sweepAmount, split) });
    await creditContribution(c, rec.merchantId, split, deps.clock());

    const upd = await c.query(
      `UPDATE daily_sweeps SET status = 'EXECUTED', debit_reference = $2, executed_at = $3, failure_reason = NULL, last_error = NULL
        WHERE id = $1 RETURNING ${SWEEP_COLS}`,
      [rec.id, debitReference, deps.clock()],
    );
    await enqueueSms(c, {
      merchantId: merchant.id,
      to: merchant.phone_number,
      kind: 'SWEEP_RECEIPT',
      dedupeKey: `receipt:${rec.id}`,
      at: deps.clock(),
      body: sweepReceipt(merchant.preferred_language, {
        takings: nairaDisplay(rec.totalTakings),
        rate: rateDisplay(rec.rateHundredths),
        sweep: nairaDisplay(rec.sweepAmount),
        emergency: nairaDisplay(rec.emergency),
        retirement: nairaDisplay(rec.retirement),
        reference: rec.pensionReference!,
      }),
    });
    return { record: mapSweep(upd.rows[0]), already: false };
  });
}

export const sweepKey = (merchantId: string, sweepDate: string) => `sweep:${merchantId}:${sweepDate}`;

/** Debit with bounded in-run retries (exponential backoff), then settle. Safe to call again for the same PENDING row. */
export async function debitAndSettle(deps: Deps, start: SweepRecord): Promise<SweepRecord> {
  const cfg = deps.config.sweep;
  const merchant = await loadMerchant(deps.db, start.merchantId);
  let rec = start;
  let attempts = rec.attempts;
  if (attempts >= cfg.maxAttempts) return markFailed(deps, rec, 'RETRIES_EXHAUSTED', rec.lastError);

  let lastError = '';
  for (let i = 0; i < cfg.inRunTries && attempts < cfg.maxAttempts; i++) {
    attempts++;
    await deps.db.query('UPDATE daily_sweeps SET attempts = attempts + 1 WHERE id = $1', [rec.id]);
    try {
      const res = await deps.executor.debit({
        idempotencyKey: sweepKey(rec.merchantId, rec.sweepDate),
        merchantId: rec.merchantId,
        nuban: merchant.access_nuban,
        amount: rec.sweepAmount,
        narration: `Kobo Kobo pension ${rec.pensionReference}`,
        pensionReference: rec.pensionReference!,
      });
      if (res.amount !== rec.sweepAmount) {
        // Money moved, but not the amount we asked for. Never post a ledger that disagrees with the bank: stop for ops.
        return markFailed(deps, rec, 'AMOUNT_MISMATCH', `asked ${koboToNaira(rec.sweepAmount)}, bank debited ${koboToNaira(res.amount)} (ref ${res.debitReference})`);
      }
      return (await finalizeSweep(deps, rec.id, res.debitReference)).record;
    } catch (e) {
      if (!(e instanceof ExecutorError)) throw e;
      if (!e.retryable) return markFailed(deps, rec, e.code, e.message);
      lastError = `${e.code}: ${e.message}`;
      await deps.db.query('UPDATE daily_sweeps SET last_error = $2 WHERE id = $1', [rec.id, lastError]);
      if (i < cfg.inRunTries - 1 && attempts < cfg.maxAttempts) await sleep(cfg.backoffBaseMs * 2 ** i);
    }
  }
  if (attempts >= cfg.maxAttempts) return markFailed(deps, rec, 'RETRIES_EXHAUSTED', lastError);
  return (await loadSweep(deps.db, rec.merchantId, rec.sweepDate))!; // still PENDING: the next run resumes with the same key
}

/** Refuse to sweep a window that is still open (it would lock in partial takings). */
export function assertWindowClosed(sweepDate: string, now: Date, allowEarly: boolean): void {
  if (!allowEarly && now < sweepCutoff(sweepDate)) {
    throw new AppError('WINDOW_STILL_OPEN', `The sweep window for ${sweepDate} closes at 23:00 WAT. Pass allow_early=true for a demo run.`, 409);
  }
}

/**
 * Run (or resume) one merchant's sweep for a date. Safe to call any number of times, concurrently:
 *  - a terminal row (executed/skipped/held/failed) is returned as-is,
 *  - a PENDING row resumes the debit with the SAME idempotency key (so a lost response never double-debits).
 */
export async function executeSweepForMerchant(deps: Deps, merchantId: string, sweepDate: string): Promise<SweepRecord> {
  let rec = await loadSweep(deps.db, merchantId, sweepDate);
  if (!rec) rec = await planAndRecord(deps, merchantId, sweepDate);
  if (rec.status !== 'PENDING') return rec;
  return debitAndSettle(deps, rec);
}

/**
 * Rails-driven path: Rails already debited the merchant and tells us it is confirmed. We validate the amount against
 * what the merchant's rules allow, then post the ledger, credit the pots and queue the SMS receipt (one transaction).
 * Idempotent per (merchant, date).
 */
export async function settleExternalDebit(
  deps: Deps,
  a: { merchantId: string; sweepDate: string; amount: Kobo; debitReference: string },
): Promise<{ record: SweepRecord; already: boolean }> {
  let rec = await loadSweep(deps.db, a.merchantId, a.sweepDate);

  if (rec?.status === 'EXECUTED') {
    if (rec.sweepAmount !== a.amount) {
      throw new AppError('SWEEP_AMOUNT_CONFLICT', 'This sweep was already settled with a different amount.', 409, { settled_amount: koboToNaira(rec.sweepAmount) });
    }
    return { record: rec, already: true };
  }
  if (rec && rec.status !== 'PENDING') {
    throw new AppError('SWEEP_STATE_CONFLICT', `Core recorded this sweep as ${rec.status}; settle refused. Resolve it with ops.`, 409, { status: rec.status });
  }
  if (rec && rec.sweepAmount !== a.amount) {
    throw new AppError('SWEEP_AMOUNT_CONFLICT', 'A pending sweep exists with a different amount.', 409, { pending_amount: koboToNaira(rec.sweepAmount) });
  }

  if (!rec) {
    const merchant = await loadMerchant(deps.db, a.merchantId);
    const hasRsa = await deps.db.query('SELECT 1 FROM pension_accounts WHERE merchant_id = $1', [a.merchantId]);
    if (hasRsa.rowCount === 0) throw new AppError('PENSION_ACCOUNT_MISSING', 'Merchant has no RSA yet.', 422);

    const { total } = await windowInflows(deps.db, a.merchantId, a.sweepDate);
    const rateHundredths = rateToHundredths(merchant.sweep_percentage);
    const { sweep: allowed } = computeSweepAmount({ takings: total, rateHundredths, dailyCap: dbToKobo(merchant.daily_cap) });
    if (a.amount > allowed) {
      throw new AppError('AMOUNT_EXCEEDS_ALLOWED', `Amount is above what takings, rate and daily cap allow (${koboToNaira(allowed)}).`, 422, {
        allowed: koboToNaira(allowed),
        total_takings: koboToNaira(total),
      });
    }
    const split = splitSweep(a.amount);
    const pensionReference = await reservePenReference(deps.db, a.merchantId, a.sweepDate);
    rec =
      (await insertSweep(deps.db, { merchantId: a.merchantId, sweepDate: a.sweepDate, status: 'PENDING', takings: total, rateHundredths, sweep: a.amount, emergency: split.emergency, retirement: split.retirement, pensionReference })) ??
      (await loadSweep(deps.db, a.merchantId, a.sweepDate))!;
    if (rec.status === 'PENDING' && rec.sweepAmount !== a.amount) {
      throw new AppError('SWEEP_AMOUNT_CONFLICT', 'A pending sweep exists with a different amount.', 409);
    }
  }
  return finalizeSweep(deps, rec.id, a.debitReference);
}
