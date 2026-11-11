import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";

export const requestId = () => "req_" + randomBytes(4).toString("hex");

const HTTP: Record<string, number> = {
  INVALID_REQUEST: 400, UNAUTHORIZED: 401, INSUFFICIENT_FUNDS: 402,
  ACCOUNT_RESTRICTED: 403, CONSENT_REQUIRED: 403,
  ACCOUNT_NOT_FOUND: 404, NOT_FOUND: 404,
  DUPLICATE_REQUEST: 409, NAME_ENQUIRY_EXPIRED: 409, NAME_ENQUIRY_MISMATCH: 409,
  ACCOUNT_DORMANT: 422, BENEFICIARY_FROZEN: 422, LIMIT_EXCEEDED: 422,
  BVN_MISMATCH: 422, INVALID_OTP: 422,
  RATE_LIMITED: 429, BANK_UNAVAILABLE: 503, TIMEOUT: 504,
};

export function ok(
  reply: FastifyReply,
  data: unknown,
  message = "Request completed",
  meta: unknown = null,
  status = 200
) {
  return reply.code(status).send({ status: "success", message, data, meta, request_id: requestId() });
}

export function fail(
  reply: FastifyReply,
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
) {
  return reply
    .code(HTTP[code] ?? 400)
    .send({ status: "error", error: { code, message, ...extra }, request_id: requestId() });
}