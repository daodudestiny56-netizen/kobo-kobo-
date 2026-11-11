import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { listAlerts, resolveAlert } from '../sweeps/alerts';
import { runBatch } from '../sweeps/batch';
import { mapSweep, requeryDue } from '../sweeps/engine';
import { requeryWithdrawalsDue } from '../withdrawals/service';
import { reconciliationReport } from '../reconciliation/report';
import { createSuggestion } from '../smart-rate/service';
import { merchantSummary } from '../merchants/summary';
import { listActiveMerchants } from '../merchants/service';
import { upcomingSweepDate } from '../time';
import { requireOps } from './auth';
import { ok } from './respond';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Everything under /api/v1/ops needs the ops token. */
export function opsRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (ops) => {
    ops.addHook('preHandler', requireOps(deps));

    // Run a sweep now. `as_of` defaults to the sweep that has not been cut yet. `force_outcome` sets the sandbox
    // x-test-outcome header on the transfers (successful | failed | pending | timeout | reversed).
    ops.post('/sweeps/run', async (req) => {
      const b = z
        .object({ as_of: date.optional(), force_outcome: z.enum(['successful', 'failed', 'pending', 'timeout', 'reversed']).optional(), allow_early: z.boolean().default(false), merchant_id: z.string().uuid().optional() })
        .default({})
        .parse(req.body ?? {});
      const r = await runBatch(deps, b.as_of ?? upcomingSweepDate(deps.clock()), { allowEarly: b.allow_early, forceOutcome: b.force_outcome, onlyMerchantId: b.merchant_id });
      return ok(r);
    });

    ops.post('/requery', async () => {
      const [sweeps, withdrawals] = await Promise.all([requeryDue(deps), requeryWithdrawalsDue(deps)]);
      return ok({ sweeps, withdrawals });
    });

    ops.get('/sweeps', async (req) => {
      const q = z.object({ date: date.optional(), status: z.string().optional(), merchant_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
      const where: string[] = [];
      const p: unknown[] = [];
      if (q.date) (where.push('sweep_date = ?'), p.push(q.date));
      if (q.status) (where.push('status = ?'), p.push(q.status));
      if (q.merchant_id) (where.push('merchant_id = ?'), p.push(q.merchant_id));
      const rows = deps.db.prepare(`SELECT * FROM sweeps ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sweep_date DESC, created_at DESC LIMIT ?`).all(...p, q.limit) as any[];
      return ok({ sweeps: rows.map(mapSweep) });
    });

    ops.get('/merchants', async () => {
      const list = listActiveMerchants(deps.db).map((m) => {
        const s = merchantSummary(deps, m.id);
        return { id: m.id, fullName: m.fullName, phone: m.phone, language: m.language, rateBps: m.rateBps, paused: s.paused, pots: s.pots, takingsToday: s.takingsToday, estimatedSweep: s.estimatedSweep, eligible: s.eligibility.eligible };
      });
      return ok({ merchants: list });
    });

    ops.get('/alerts', async (req) => {
      const q = z.object({ status: z.enum(['PENDING_REVIEW', 'DISMISSED', 'CONFIRMED']).optional() }).parse(req.query);
      return ok({ alerts: listAlerts(deps.db, q.status) });
    });

    ops.post('/alerts/:id/resolve', async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ action: z.enum(['DISMISS', 'CONFIRM']), note: z.string().max(500).optional(), by: z.string().max(60).default('ops') }).parse(req.body);
      return ok({ alert: resolveAlert(deps.db, id, b.action, b.by, b.note ?? null, deps.clock()) });
    });

    ops.get('/reconciliation', async () => ok(await reconciliationReport(deps)));

    // SmartRate (Tomiwa) proposes a rate here. The trader still has to say YES.
    ops.post('/suggestions', async (req, reply) => {
      const b = z.object({ merchant_id: z.string().uuid(), suggested_bps: z.number().int(), reason: z.string().max(300).optional() }).parse(req.body);
      return reply.status(201).send(ok(createSuggestion(deps, { merchantId: b.merchant_id, suggestedBps: b.suggested_bps, reason: b.reason })));
    });
  }, { prefix: '/ops' });
}
