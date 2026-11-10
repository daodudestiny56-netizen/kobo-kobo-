import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { changePin, hasPin, setPin, verifyPin } from '../security/pin';

const idParam = z.object({ id: z.string().uuid() });

export function pinRoutes(app: FastifyInstance, deps: Deps) {
  /** POST /api/v1/merchants/:id/pin { pin, reset? } - set at onboarding (409 if one exists unless reset=true, for ops-verified resets). */
  app.post('/api/v1/merchants/:id/pin', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ pin: z.string(), reset: z.boolean().optional() }), req.body);
    await setPin(deps, id, b.pin, { reset: b.reset });
    reply.code(204);
  });

  /** POST /api/v1/merchants/:id/pin/verify { pin } -> 200 { valid: true } | 401 PIN_INVALID | 423 PIN_LOCKED | 422 PIN_NOT_SET */
  app.post('/api/v1/merchants/:id/pin/verify', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ pin: z.string() }), req.body);
    await verifyPin(deps, id, b.pin);
    return { valid: true };
  });

  /** POST /api/v1/merchants/:id/pin/change { old_pin, new_pin } */
  app.post('/api/v1/merchants/:id/pin/change', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ old_pin: z.string(), new_pin: z.string() }), req.body);
    await changePin(deps, id, b.old_pin, b.new_pin);
    reply.code(204);
  });

  /** GET /api/v1/merchants/:id/pin -> { pin_set } */
  app.get('/api/v1/merchants/:id/pin', async (req) => {
    const { id } = parse(idParam, req.params);
    return { pin_set: await hasPin(deps, id) };
  });
}
