import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { bank } from "../bank/index.js";
import { BankError, BankNetworkError } from "../bank/types.js";
import { demoGate, demoEnabled } from "./gate.js";
import { getOffsetDays, setOffsetDays, now } from "./clock.js";
import { resetDemo } from "./reset.js";

const clockState = () => ({ offsetDays: getOffsetDays(), active: getOffsetDays() !== 0, now: now().toISOString() });
const bad = (code: string, message: string) => ({ error: { code, message } });

export async function demoRoutes(app: FastifyInstance) {
  app.get("/api/v1/demo/clock", async () => clockState());

  if (!demoEnabled()) return;

  await app.register(async (g) => {
    g.addHook("onRequest", demoGate);

    g.post<{ Body: { days?: number } }>("/api/v1/demo/clock", async (req, reply) => {
      const days = req.body?.days;
      if (typeof days !== "number" || !Number.isFinite(days) || days < 0 || days > 400) {
        return reply.code(400).send(bad("INVALID_REQUEST", "days must be a number from 0 to 400"));
      }
      setOffsetDays(days);
      return clockState();
    });

    g.post<{ Body: { merchantId?: string; amountKobo?: number; count?: number; from?: string } }>(
      "/api/v1/demo/inflow",
      async (req, reply) => {
        const b = req.body ?? {};
        if (typeof b.amountKobo !== "number" || !Number.isInteger(b.amountKobo) || b.amountKobo < 100 || b.amountKobo > 1_000_000_000) {
          return reply.code(400).send(bad("INVALID_REQUEST", "amountKobo must be an integer from 100 to 1,000,000,000"));
        }
        const count = b.count ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 5) {
          return reply.code(400).send(bad("INVALID_REQUEST", "count must be 1 to 5"));
        }
        const m = db.prepare("SELECT bank_account FROM merchants WHERE id = ? AND status = 'ACTIVE'").get(b.merchantId ?? "") as
          | { bank_account: string } | undefined;
        if (!m) return reply.code(404).send(bad("MERCHANT_NOT_FOUND", "No active merchant with that id"));

        const source = b.from ?? process.env.DEMO_PAYER_ACCOUNT ?? "0123456793";
        if (source === m.bank_account) return reply.code(400).send(bad("INVALID_REQUEST", "payer and trader are the same account"));

        const results: { reference: string; outcome: string }[] = [];
        try {
          for (let i = 0; i < count; i++) {
            const ne = await bank.nameEnquiry(m.bank_account);
            const stamp = `${Date.now().toString(36)}${i}`;
            const reference = `KOBO-IN-${stamp}`;
            const r = await bank.sendIntra({
              idempotencyKey: `demo-${stamp}`, reference, sourceAccount: source, destinationAccount: m.bank_account,
              nameEnquiryRef: ne.ref, amountKobo: b.amountKobo, narration: "Demo sale",
            });
            results.push({ reference, outcome: r.outcome });
          }
        } catch (e) {
          if (e instanceof BankError || e instanceof BankNetworkError) {
            console.warn("[demo] inflow failed:", e instanceof BankError ? e.code : "network");
            return reply.code(502).send({ ...bad("BANK_UNAVAILABLE", "Bank call failed"), results });
          }
          throw e;
        }
        return { merchantId: b.merchantId, amountKobo: b.amountKobo, results };
      },
    );

    g.post<{ Body: { bank?: boolean } }>("/api/v1/demo/reset", async (req, reply) => {
      try {
        return { ok: true, ...(await resetDemo({ bank: req.body?.bank === true })) };
      } catch (e) {
        if ((e as Error).message === "RESET_IN_PROGRESS") return reply.code(409).send(bad("RESET_IN_PROGRESS", "A reset is already running"));
        console.warn("[demo] reset failed:", (e as Error).message);
        return reply.code(502).send(bad("RESET_FAILED", "Reset failed, check the logs"));
      }
    });
  });
}
