import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { koboToNaira, parsePositiveNaira } from '../money';
import { assertDateString } from '../time';
import { previewSplit } from '../split/service';

const body = z.object({
  merchant_id: z.string().uuid(),
  sweep_date: z.string(),
  sweep_amount: z.union([z.string(), z.number()]),
});

export function splitRoutes(app: FastifyInstance, deps: Deps) {
  /**
   * POST /api/v1/split
   * { merchant_id, sweep_date: "2026-11-06", sweep_amount: "900.00" }
   * -> 50/50 allocation, reserved PEN reference, the ledger lines settlement will post.
   */
  app.post('/api/v1/split', async (req) => {
    const b = parse(body, req.body);
    const p = await previewSplit(deps, {
      merchantId: b.merchant_id,
      sweepDate: assertDateString(b.sweep_date),
      amount: parsePositiveNaira(b.sweep_amount),
    });
    return {
      merchant_id: p.merchantId,
      sweep_date: p.sweepDate,
      currency: 'NGN',
      sweep_amount: koboToNaira(p.sweepAmount),
      allocations: {
        emergency_pot: koboToNaira(p.split.emergency),
        retirement_pot: koboToNaira(p.split.retirement),
      },
      pension_reference: p.pensionReference,
      ledger_entries: p.ledger.map((l) => ({
        account_type: l.accountType,
        entry_type: l.entryType,
        amount: koboToNaira(l.amount),
      })),
    };
  });
}
