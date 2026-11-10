import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Internal endpoints (called by the Rails service / ops): `Authorization: Bearer <SERVICE_TOKEN>`. Empty token = open (dev). */
export function serviceAuth(token: string) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!token) return;
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), token)) {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid service token.', 401);
    }
  };
}

/** Telco webhooks (USSD/SMS) cannot send headers reliably, so they carry `?token=`. Empty token = open (dev). */
export function webhookAuth(token: string) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!token) return;
    const given = (req.query as Record<string, string | undefined>)?.token ?? '';
    if (!safeEqual(given, token)) throw new AppError('UNAUTHORIZED', 'Missing or invalid webhook token.', 401);
  };
}
