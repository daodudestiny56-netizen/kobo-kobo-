import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { getOffsetDays, setOffsetDays } from '../demo/clock';
import { seedDemo } from '../demo/seed';
import { recordInflow } from '../inflows/service';
import { findMerchantByPhone } from '../merchants/service';
import { parsePositiveNaira } from '../money';
import { normalizePhone } from '../phone';
import { requireDemo } from './auth';
import { ok } from './respond';

/** Demo-only controls (DEMO_MODE=true and the ops token). They do not exist in a non-demo deployment. */
export function demoRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (demo) => {
    demo.addHook('preHandler', requireDemo(deps));

    // "A customer pays this trader": the same recordInflow the webhook uses.
    demo.post('/demo/inflow', async (req, reply) => {
      const b = z
        .object({ merchant_id: z.string().uuid().optional(), phone: z.string().optional(), amount_naira: z.union([z.string(), z.number()]), channel: z.enum(['POS', 'NIP_TRANSFER', 'QR']).default('NIP_TRANSFER') })
        .parse(req.body);
      let merchantId = b.merchant_id;
      if (!merchantId) {
        const phone = b.phone ? normalizePhone(b.phone) : null;
        const m = phone ? findMerchantByPhone(deps.db, phone) : null;
        if (!m) throw new AppError('MERCHANT_NOT_FOUND', 'Give merchant_id or the phone of a registered trader.', 404);
        merchantId = m.id;
      }
      const r = recordInflow(deps, { merchantId, amount: parsePositiveNaira(b.amount_naira), channel: b.channel, bankReference: `DEMO-${crypto.randomUUID()}` });
      return reply.status(201).send(ok(r));
    });

    // Moves only the withdrawal-eligibility clock (vesting and cooldown). Sweep windows always use the real time.
    demo.get('/demo/clock', async () => ok({ offsetDays: getOffsetDays(deps.db) }));
    demo.post('/demo/clock', async (req) => {
      const b = z.object({ offset_days: z.number().int().min(0).max(3650) }).parse(req.body);
      setOffsetDays(deps.db, b.offset_days);
      return ok({ offsetDays: b.offset_days });
    });

    // Wipe everything and rebuild the seven demo personas.
    demo.post('/demo/reset', async () => ok(await seedDemo(deps)));
  });
}
