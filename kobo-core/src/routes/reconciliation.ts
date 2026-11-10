import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps';
import { reconcile } from '../reconciliation/report';
import { addDays, assertDateString, currentSweepDate, sweepCutoff } from '../time';

export function reconciliationRoutes(app: FastifyInstance, deps: Deps) {
  /** GET /api/v1/reconciliation?date=YYYY-MM-DD (default: last closed sweep date) */
  app.get('/api/v1/reconciliation', async (req) => {
    const q = req.query as { date?: string };
    const date = q.date ? assertDateString(q.date) : (deps.clock().getTime() >= sweepCutoff(currentSweepDate(deps.clock())).getTime() ? currentSweepDate(deps.clock()) : addDays(currentSweepDate(deps.clock()), -1));
    return reconcile(deps, date);
  });
}
