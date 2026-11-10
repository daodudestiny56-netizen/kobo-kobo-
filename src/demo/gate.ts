import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const digest = (s: string) => createHash("sha256").update(s).digest();

export const demoEnabled = () => process.env.DEMO_MODE === "1";

/** onRequest hook. 404 when no secret is configured, 401 on a wrong or missing key. */
export async function demoGate(req: FastifyRequest, reply: FastifyReply) {
  const secret = process.env.DEMO_SECRET;
  if (!secret) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
  const given = String(req.headers["x-demo-key"] ?? "");
  if (!timingSafeEqual(digest(given), digest(secret))) {
    return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Missing or wrong demo key" } });
  }
}
