import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { handleInboundSms } from '../channels/sms-commands';
import { handleUssd } from '../channels/ussd';
import type { Deps } from '../deps';
import { parse } from '../http/validate';
import { handleVoiceWebhook } from '../voice/service';

/** Telco-facing webhooks (Africa's Talking / Termii). Authenticated with `?token=` instead of the service token. */
export function channelRoutes(app: FastifyInstance, deps: Deps) {
  /**
   * POST /api/v1/ussd  (application/x-www-form-urlencoded as AT sends it; JSON also accepted for the PWA simulator)
   * sessionId, serviceCode, phoneNumber, text  ->  text/plain "CON ..." | "END ..."
   */
  app.post('/api/v1/ussd', async (req, reply) => {
    const b = parse(
      z.object({ sessionId: z.string().optional(), serviceCode: z.string().optional(), phoneNumber: z.string().min(5), text: z.string().default('') }),
      req.body,
    );
    const out = await handleUssd(deps, { phoneNumber: b.phoneNumber, text: b.text });
    return reply.type('text/plain; charset=utf-8').send(out);
  });

  /**
   * POST /api/v1/sms/inbound  { from, text, timestamp? }  (AT form posts also carry id, to, date, linkId)
   * -> { reply }. The reply is also queued as an SMS to the trader.
   */
  app.post('/api/v1/sms/inbound', async (req) => {
    const b = parse(z.object({ from: z.string().min(5), text: z.string().default(''), id: z.string().optional() }).passthrough(), req.body);
    const { reply } = await handleInboundSms(deps, { from: b.from, text: b.text, messageId: b.id });
    return { reply };
  });

  /**
   * POST /api/v1/voice/callback - Africa's Talking Voice. isActive=1 -> <Response><Say>..</Say></Response> (the spoken balance),
   * isActive=0 (call ended) -> 204. Covers calls we placed (clientRequestId) and traders dialling in (callerNumber).
   */
  app.post('/api/v1/voice/callback', async (req, reply) => {
    const b = parse(
      z
        .object({
          isActive: z.string().optional(),
          direction: z.string().optional(),
          callerNumber: z.string().optional(),
          destinationNumber: z.string().optional(),
          clientRequestId: z.string().optional(),
          sessionId: z.string().optional(),
          callSessionState: z.string().optional(),
          durationInSeconds: z.string().optional(),
        })
        .passthrough(),
      req.body,
    );
    const r = await handleVoiceWebhook(deps, b);
    if ('done' in r) return reply.code(204).send();
    return reply.type('application/xml; charset=utf-8').send(r.xml);
  });
}
