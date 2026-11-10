import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { issueRsaPin, PFA_CODE, PFA_NAME } from '../pfa/simulator';

export function pfaRoutes(app: FastifyInstance, deps: Deps) {
  /** POST /api/v1/pfa/rsa-pin { merchant_id } -> mock ECRS RSA PIN. 201 when issued, 200 when it already existed. */
  app.post('/api/v1/pfa/rsa-pin', async (req, reply) => {
    const { merchant_id } = parse(z.object({ merchant_id: z.string().uuid() }), req.body);
    const r = await issueRsaPin(deps.db, merchant_id);
    reply.code(r.created ? 201 : 200);
    return { merchant_id: r.merchantId, rsa_pin: r.rsaPin, pfa: PFA_NAME, pfa_code: PFA_CODE, created: r.created };
  });
}
