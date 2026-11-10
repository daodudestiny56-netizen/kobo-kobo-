import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { koboToNaira, parsePositiveNaira } from '../money';
import { runNightlyBatch } from '../sweeps/batch';
import { assertWindowClosed, executeSweepForMerchant, settleExternalDebit, type SweepRecord } from '../sweeps/service';
import { assertDateString, toWatDate } from '../time';

function sweepGuardStatus(r: SweepRecord): 'CLEARED' | 'HELD' | 'NOT_EVALUATED' {
  if (r.status === 'HELD_GUARD') return 'HELD';
  if (r.status === 'SKIPPED_PAUSED' || r.status === 'SKIPPED_ZERO_SALES') return 'NOT_EVALUATED';
  return 'CLEARED';
}

/** Shape follows PRD 6.2; money is a decimal string so no precision is lost in JSON. */
export function presentSweep(r: SweepRecord) {
  return {
    sweep_id: r.id,
    merchant_id: r.merchantId,
    sweep_date: r.sweepDate,
    status: r.status,
    total_takings: koboToNaira(r.totalTakings),
    sweep_percentage: koboToNaira(r.rateHundredths),
    sweep_amount: koboToNaira(r.sweepAmount),
    allocations: { emergency_pot: koboToNaira(r.emergency), retirement_pot: koboToNaira(r.retirement) },
    pension_reference: r.pensionReference,
    debit_reference: r.debitReference,
    sweep_guard_status: sweepGuardStatus(r),
    failure_reason: r.failureReason,
    attempts: r.attempts,
    timestamp: (r.executedAt ?? new Date()).toISOString(),
  };
}

export function sweepRoutes(app: FastifyInstance, deps: Deps) {
  /** POST /api/v1/sweeps/execute { merchant_id, target_date, allow_early? } - run or resume one merchant's sweep. */
  app.post('/api/v1/sweeps/execute', async (req) => {
    const b = parse(z.object({ merchant_id: z.string().uuid(), target_date: z.string(), allow_early: z.boolean().optional() }), req.body);
    const date = assertDateString(b.target_date);
    assertWindowClosed(date, deps.clock(), b.allow_early ?? false);
    return presentSweep(await executeSweepForMerchant(deps, b.merchant_id, date));
  });

  /** POST /api/v1/sweeps/nightly-batch { target_date?, allow_early? } - what the 23:00 cron runs; also callable by ops. */
  app.post('/api/v1/sweeps/nightly-batch', async (req, reply) => {
    const b = parse(z.object({ target_date: z.string().optional(), allow_early: z.boolean().optional() }), req.body);
    const date = b.target_date ? assertDateString(b.target_date) : toWatDate(deps.clock());
    assertWindowClosed(date, deps.clock(), b.allow_early ?? false);
    const r = await runNightlyBatch(deps, date);
    if (r.alreadyRunning) {
      reply.code(409);
      return { error: { code: 'BATCH_ALREADY_RUNNING', message: `A nightly batch for ${date} is already running.` } };
    }
    return r.summary;
  });

  /**
   * POST /api/v1/sweeps/settle { merchant_id, sweep_date, sweep_amount, debit_reference }
   * Rails calls this after a CONFIRMED debit. Posts the ledger, credits both pots, queues the SMS receipt.
   * Idempotent per (merchant_id, sweep_date): 200 with already_settled=true on a repeat.
   */
  app.post('/api/v1/sweeps/settle', async (req) => {
    const b = parse(
      z.object({
        merchant_id: z.string().uuid(),
        sweep_date: z.string(),
        sweep_amount: z.union([z.string(), z.number()]),
        debit_reference: z.string().min(1).max(100),
      }),
      req.body,
    );
    const { record, already } = await settleExternalDebit(deps, {
      merchantId: b.merchant_id,
      sweepDate: assertDateString(b.sweep_date),
      amount: parsePositiveNaira(b.sweep_amount),
      debitReference: b.debit_reference,
    });
    return { ...presentSweep(record), already_settled: already, sms_receipt: 'QUEUED' };
  });
}
