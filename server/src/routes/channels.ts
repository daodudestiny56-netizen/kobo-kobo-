import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { handleUssd } from '../channels/ussd';
import { handleInboundSms } from '../channels/sms';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/**
 * The two phone channels, called by the on-screen simulators (Destiny) the way a telco gateway would.
 * Accepts JSON or form-encoded, with Africa's Talking style names or snake_case.
 */
export function channelRoutes(app: FastifyInstance, deps: Deps): void {
  // USSD replies are plain text starting with CON (menu continues) or END (session over).
  app.post('/ussd', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const body = z.object({ phone: z.string().min(5).max(20), text: z.string().max(200) }).parse({
      phone: str(b.phoneNumber ?? b.phone_number ?? b.phone),
      text: str(b.text),
    });
    const out = await handleUssd(deps, { phoneNumber: body.phone, text: body.text });
    return reply.type('text/plain; charset=utf-8').send(out);
  });

  app.post('/sms/inbound', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const body = z.object({ from: z.string().min(5).max(20), text: z.string().min(1).max(500), id: z.string().max(100).optional() }).parse({
      from: str(b.from ?? b.phoneNumber ?? b.phone_number),
      text: str(b.text ?? b.message),
      id: b.message_id !== undefined || b.id !== undefined ? str(b.message_id ?? b.id) : undefined,
    });
    return handleInboundSms(deps, { from: body.from, text: body.text, messageId: body.id });
  });
}
