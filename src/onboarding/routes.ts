import type { FastifyInstance } from "fastify";
import { BankError, BankNetworkError } from "../bank/types.js";
import { CONSENT_TEXT, CONSENT_VERSION, OnboardError, onboard, type OnboardInput } from "./service.js";

export async function onboardingRoutes(app: FastifyInstance, opts: { perMinute?: number; mapResult?: (r: { merchantId: string }) => unknown } = {}) {
  const max = opts.perMinute ?? 5;
  const hits = new Map<string, number[]>();

  app.get("/api/v1/consent", async () => ({ version: CONSENT_VERSION, text: CONSENT_TEXT }));

  app.post<{ Body: OnboardInput }>("/api/v1/merchants/onboard", async (req, reply) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= max) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many attempts, try again in a minute" } });
    }
    hits.set(req.ip, [...recent, now]);

    try {
      const created = await onboard(req.body ?? {});
      return reply.code(201).send(opts.mapResult ? opts.mapResult(created) : created);
    } catch (e) {
      if (e instanceof OnboardError) {
        return reply.code(e.status).send({ error: { code: e.code, message: e.message, field: e.field } });
      }
      if (e instanceof BankError || e instanceof BankNetworkError) {
        console.warn("[onboard] bank check failed:", e instanceof BankError ? e.code : "network");
        return reply.code(502).send({ error: { code: "BANK_UNAVAILABLE", message: "Bank check failed, try again" } });
      }
      throw e;
    }
  });
}
