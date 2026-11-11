import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { listAlerts, resolveAlert } from '../sweeps/alerts';
import { runBatch } from '../sweeps/batch';
import { advanceSweep, getSweepById, mapSweep, requeryDue } from '../sweeps/engine';
import { requeryWithdrawalsDue } from '../withdrawals/service';
import { reconciliationReport } from '../reconciliation/report';
import { analyzeMerchant, runSmartRate } from '../smart-rate/analyze';
import { createSuggestion } from '../smart-rate/service';
import { listActiveMerchants } from '../merchants/service';
import { toWatDate } from '../time';
import { webMerchant, webOverview } from '../web/mappers';
import { requireOps } from './auth';
import { ok } from './respond';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const FORCE = { none: undefined, failed: 'failed', timeout: 'timeout', reversed: 'reversed', pending: 'pending', successful: 'successful' } as const;

/** Everything under /api/v1/ops needs ops access (see routes/auth.ts). Replies are the shapes the ops dashboard reads. */
export function opsRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (ops) => {
    ops.addHook('preHandler', requireOps(deps));

    ops.get('/overview', async () => ok(await webOverview(deps)));

    ops.get('/merchants', async () => ok(listActiveMerchants(deps.db).map((m) => webMerchant(deps, m))));

    // Run tonight's sweep now: asOf defaults to today's date in Lagos (so 23:05 runs the sweep that just closed). In demo mode this may run before the 23:00 cutoff. `forceOutcome` sets the sandbox
    // x-test-outcome header on the transfers.
    ops.post('/sweeps/run', async (req) => {
      const b = z
        .object({ asOf: date.optional(), forceOutcome: z.enum(['none', 'failed', 'timeout', 'reversed', 'pending', 'successful']).default('none'), allowEarly: z.boolean().optional(), merchantId: z.string().uuid().optional() })
        .default({})
        .parse(req.body ?? {});
      await runBatch(deps, b.asOf ?? toWatDate(deps.clock()), { allowEarly: b.allowEarly ?? deps.config.demoMode, forceOutcome: FORCE[b.forceOutcome], onlyMerchantId: b.merchantId });
      return ok(await webOverview(deps));
    });

    ops.post('/sweeps/:id/requery', async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      if (!getSweepById(deps.db, id)) throw new AppError('SWEEP_NOT_FOUND', 'No such sweep.', 404);
      await advanceSweep(deps, id);
      return ok(await webOverview(deps));
    });

    ops.post('/requery', async () => {
      const [sweeps, withdrawals] = await Promise.all([requeryDue(deps), requeryWithdrawalsDue(deps)]);
      return ok({ sweeps, withdrawals });
    });

    ops.get('/sweeps', async (req) => {
      const q = z.object({ date: date.optional(), status: z.string().optional(), merchantId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
      const where: string[] = [];
      const p: unknown[] = [];
      if (q.date) (where.push('sweep_date = ?'), p.push(q.date));
      if (q.status) (where.push('status = ?'), p.push(q.status));
      if (q.merchantId) (where.push('merchant_id = ?'), p.push(q.merchantId));
      const rows = deps.db.prepare(`SELECT * FROM sweeps ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sweep_date DESC, created_at DESC LIMIT ?`).all(...p, q.limit) as any[];
      return ok({ sweeps: rows.map(mapSweep) });
    });

    ops.get('/alerts', async (req) => {
      const q = z.object({ status: z.enum(['PENDING_REVIEW', 'DISMISSED', 'CONFIRMED']).optional() }).parse(req.query);
      return ok({ alerts: listAlerts(deps.db, q.status) });
    });

    // decision: DISMISSED (the credit was fine, it counts from now) or CONFIRMED (the flag was right, exclude it for good).
    ops.post('/alerts/:id/resolve', async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ decision: z.enum(['DISMISSED', 'CONFIRMED']), note: z.string().max(500).optional(), by: z.string().max(60).default('ops') }).parse(req.body);
      resolveAlert(deps.db, id, b.decision === 'DISMISSED' ? 'DISMISS' : 'CONFIRM', b.by, b.note ?? null, deps.clock());
      return ok(await webOverview(deps));
    });

    ops.get('/reconciliation', async () => ok(await reconciliationReport(deps)));

    // Run SmartRate now (all traders, or one). `file: false` only analyses and files nothing. The trader still has to say YES.
    ops.post('/smart-rate/run', async (req) => {
      const b = z.object({ merchantId: z.string().uuid().optional(), file: z.boolean().default(true) }).parse(req.body ?? {});
      return ok(b.merchantId ? [analyzeMerchant(deps, b.merchantId, { file: b.file })] : b.file ? runSmartRate(deps) : listActiveMerchants(deps.db).map((m) => analyzeMerchant(deps, m.id, { file: false })));
    });

    // SmartRate proposes a rate here. The trader still has to say YES.
    ops.post('/suggestions', async (req, reply) => {
      const b = z.object({ merchantId: z.string().uuid(), suggestedBps: z.number().int(), reason: z.string().max(300).optional() }).parse(req.body);
      return reply.status(201).send(ok(createSuggestion(deps, { merchantId: b.merchantId, suggestedBps: b.suggestedBps, reason: b.reason })));
    });
  }, { prefix: '/ops' });
}
