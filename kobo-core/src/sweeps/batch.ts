import type { Deps } from '../deps';
import { koboToNaira, type Kobo } from '../money';
import { mapLimit } from '../util/async';
import { executeSweepForMerchant, type SweepRecord } from './service';

export interface BatchSummary {
  execution_date: string;
  processed_merchants: number;
  successful_sweeps: number;
  zero_sales_skipped: number;
  paused_skipped: number;
  buffer_skipped: number;
  guard_alerts_held: number;
  failed: number;
  /** Debit outcome unknown after retries; the next run resumes these with the same idempotency key. */
  pending_retry: number;
  /** Merchants whose sweep threw before anything was recorded (e.g. balance lookup down); retried by the next run. */
  errors: number;
  total_aum_swept_ngn: string;
}

export type BatchResult = { alreadyRunning: false; summary: BatchSummary } | { alreadyRunning: true };

/**
 * Sweep every onboarded merchant (those with an RSA) for `sweepDate`. Only one batch per date runs at a time
 * across all instances (Postgres advisory lock). Re-running is safe and is how retries work: finished sweeps are
 * skipped, PENDING ones resume, merchants that errored before recording anything are planned again.
 * The summary describes the state of the whole night after this run, not just this run's work.
 */
export async function runNightlyBatch(deps: Deps, sweepDate: string): Promise<BatchResult> {
  const lockClient = await deps.db.connect();
  try {
    const lock = await lockClient.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`kobo:nightly-batch:${sweepDate}`]);
    if (!lock.rows[0].ok) return { alreadyRunning: true };
    try {
      const { rows } = await deps.db.query<{ id: string }>(
        `SELECT m.id FROM merchants m JOIN pension_accounts p ON p.merchant_id = m.id ORDER BY m.created_at, m.id`,
      );
      // Leave pool headroom for the lock connection and for the services each sweep calls.
      const concurrency = Math.max(1, Math.min(deps.config.sweep.batchConcurrency, 12));
      const outcomes = await mapLimit(rows, concurrency, async (m): Promise<SweepRecord | 'ERROR'> => {
        try {
          return await executeSweepForMerchant(deps, m.id, sweepDate);
        } catch (e) {
          console.error(`[sweep] merchant ${m.id} on ${sweepDate} errored:`, (e as Error).message);
          return 'ERROR';
        }
      });
      return { alreadyRunning: false, summary: summarize(sweepDate, rows.length, outcomes) };
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`kobo:nightly-batch:${sweepDate}`]);
    }
  } finally {
    lockClient.release();
  }
}

function summarize(sweepDate: string, processed: number, outcomes: Array<SweepRecord | 'ERROR'>): BatchSummary {
  const s: BatchSummary = {
    execution_date: sweepDate,
    processed_merchants: processed,
    successful_sweeps: 0,
    zero_sales_skipped: 0,
    paused_skipped: 0,
    buffer_skipped: 0,
    guard_alerts_held: 0,
    failed: 0,
    pending_retry: 0,
    errors: 0,
    total_aum_swept_ngn: '0.00',
  };
  let swept: Kobo = 0n;
  for (const o of outcomes) {
    if (o === 'ERROR') {
      s.errors++;
      continue;
    }
    switch (o.status) {
      case 'EXECUTED':
        s.successful_sweeps++;
        swept += o.sweepAmount;
        break;
      case 'SKIPPED_ZERO_SALES':
        s.zero_sales_skipped++;
        break;
      case 'SKIPPED_PAUSED':
        s.paused_skipped++;
        break;
      case 'SKIPPED_BUFFER':
        s.buffer_skipped++;
        break;
      case 'HELD_GUARD':
        s.guard_alerts_held++;
        break;
      case 'FAILED':
        s.failed++;
        break;
      case 'PENDING':
        s.pending_retry++;
        break;
    }
  }
  s.total_aum_swept_ngn = koboToNaira(swept);
  return s;
}
