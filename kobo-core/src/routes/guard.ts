import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { listAlerts, resolveGuardAlert, type GuardAlert } from '../sweeps/release';
import { presentSweep } from './sweeps';

const presentAlert = (a: GuardAlert & { sweepDate?: string | null; sweepStatus?: string | null }) => ({
  alert_id: a.id,
  merchant_id: a.merchantId,
  sweep_id: a.sweepId,
  sweep_date: a.sweepDate ?? null,
  sweep_status: a.sweepStatus ?? null,
  alert_type: a.alertType,
  status: a.status,
  details: a.details,
  created_at: a.createdAt.toISOString(),
  resolved_at: a.resolvedAt?.toISOString() ?? null,
  resolved_by: a.resolvedBy,
  resolved_via: a.resolvedVia,
  resolution_note: a.resolutionNote,
});

export function guardRoutes(app: FastifyInstance, deps: Deps) {
  /** GET /api/v1/sweep-guard/alerts?status=PENDING_REVIEW&merchant_id= - the ops review queue. */
  app.get('/api/v1/sweep-guard/alerts', async (req) => {
    const q = parse(z.object({ status: z.enum(['PENDING_REVIEW', 'DISMISSED', 'CONFIRMED']).optional(), merchant_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
    const alerts = await listAlerts(deps, { status: q.status, merchantId: q.merchant_id, limit: q.limit });
    return { alerts: alerts.map(presentAlert) };
  });

  /**
   * POST /api/v1/sweep-guard/alerts/:id/resolve { decision: RELEASE | CONFIRM, resolved_by, note? }
   * RELEASE re-plans and executes the held sweep; CONFIRM keeps it unswept. Repeating a decision is safe (200).
   */
  app.post('/api/v1/sweep-guard/alerts/:id/resolve', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['RELEASE', 'CONFIRM']), resolved_by: z.string().min(1).max(80), note: z.string().max(500).optional() }), req.body);
    const r = await resolveGuardAlert(deps, { alertId: id, decision: b.decision, resolvedBy: b.resolved_by, via: 'OPS', note: b.note });
    return { alert: presentAlert(r.alert), sweep: presentSweep(r.sweep), changed: r.changed };
  });
}
