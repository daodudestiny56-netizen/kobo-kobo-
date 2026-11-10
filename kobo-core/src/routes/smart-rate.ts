import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { rateDisplay, rateToHundredths } from '../money';
import { createSuggestion, getPendingSuggestion, respondToSuggestion, type RateSuggestion } from '../smart-rate/service';

const present = (s: RateSuggestion) => ({
  suggestion_id: s.id,
  merchant_id: s.merchantId,
  current_rate: rateDisplay(s.currentRate),
  suggested_rate: rateDisplay(s.suggestedRate),
  reason: s.reason,
  status: s.status,
  responded_via: s.respondedVia,
  expires_at: s.expiresAt.toISOString(),
  responded_at: s.respondedAt?.toISOString() ?? null,
});

export function smartRateRoutes(app: FastifyInstance, deps: Deps) {
  /** POST /api/v1/smart-rate/suggestions { merchant_id, suggested_rate, reason? } - the AI proposes; the trader is texted. Rate is NOT changed. */
  app.post('/api/v1/smart-rate/suggestions', async (req, reply) => {
    const b = parse(z.object({ merchant_id: z.string().uuid(), suggested_rate: z.union([z.string(), z.number()]), reason: z.string().max(500).optional() }), req.body);
    const s = await createSuggestion(deps, { merchantId: b.merchant_id, suggestedRate: rateToHundredths(b.suggested_rate), reason: b.reason });
    reply.code(201);
    return present(s);
  });

  /** GET /api/v1/merchants/:id/smart-rate -> the open suggestion (for the PWA banner) or null. */
  app.get('/api/v1/merchants/:id/smart-rate', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const s = await getPendingSuggestion(deps, id);
    return { suggestion: s ? present(s) : null };
  });

  /** POST /api/v1/smart-rate/suggestions/:id/respond { merchant_id, decision: ACCEPT | DECLINE } - an in-app tap, same effect as SMS YES / NO. */
  app.post('/api/v1/smart-rate/suggestions/:id/respond', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ merchant_id: z.string().uuid(), decision: z.enum(['ACCEPT', 'DECLINE']) }), req.body);
    const r = await respondToSuggestion(deps, { merchantId: b.merchant_id, decision: b.decision, via: 'APP', suggestionId: id });
    if (r.outcome === 'NONE') {
      throw new AppError('SUGGESTION_NOT_OPEN', 'That suggestion is no longer open (answered, replaced or expired).', 409);
    }
    return { ...present(r.suggestion), sweep_percentage: rateDisplay(r.rate) };
  });
}
