import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { koboToNaira, parsePositiveNaira } from '../money';
import { hasPin, verifyPin } from '../security/pin';
import { getPensionSummary } from '../pension/summary';
import { requestEmergencyWithdrawal } from '../withdrawals/service';

export function withdrawalRoutes(app: FastifyInstance, deps: Deps) {
  /** POST /api/v1/withdrawals { merchant_id, amount, pin } -> emergency pot -> merchant's own Access account. */
  app.post('/api/v1/withdrawals', async (req, reply) => {
    const b = parse(z.object({ merchant_id: z.string().uuid(), amount: z.union([z.string(), z.number()]), pin: z.string().optional() }), req.body);
    // Money-out needs the PIN. Checked before anything is reserved; wrong guesses count toward the lockout.
    if (deps.config.pin.withdrawalRequired) await verifyPin(deps, b.merchant_id, b.pin ?? '');
    const w = await requestEmergencyWithdrawal(deps, { merchantId: b.merchant_id, amount: parsePositiveNaira(b.amount) });
    reply.code(201);
    return {
      withdrawal_id: w.id,
      merchant_id: w.merchantId,
      amount: koboToNaira(w.amount),
      destination_nuban: w.destinationNuban,
      status: w.status,
      credit_reference: w.creditReference,
      failure_reason: w.failureReason,
      disbursed_at: w.disbursedAt?.toISOString() ?? null,
    };
  });

  /** GET /api/v1/merchants/:id/pension -> balances and whether (and when) the Emergency Pot can be cashed out. */
  app.get('/api/v1/merchants/:id/pension', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const s = await getPensionSummary(deps.db, id, deps.clock());
    return {
      merchant_id: s.merchantId,
      rsa_pin: s.rsaPin,
      emergency_pot: koboToNaira(s.emergency),
      retirement_pot: koboToNaira(s.retirement),
      total_saved: koboToNaira(s.total),
      first_contribution_at: s.firstContributionAt?.toISOString() ?? null,
      last_withdrawal_at: s.lastWithdrawalAt?.toISOString() ?? null,
      pin_set: await hasPin(deps, id),
      emergency_withdrawal: {
        eligible: s.eligibility.eligible,
        reason: s.eligibility.reason ?? null,
        eligible_on: s.eligibility.eligibleOn?.toISOString() ?? null,
      },
    };
  });
}
