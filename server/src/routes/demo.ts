import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { getOffsetDays, setOffsetDays } from '../demo/clock';
import { seedDemo } from '../demo/seed';
import { DEMO_TRADERS } from '../demo/traders';
import { recordInflow } from '../inflows/service';
import { findMerchantByPhone, getMerchant, onboardMerchant } from '../merchants/service';
import { webMerchant } from '../web/mappers';
import { requireDemo, requireDemoMode } from './auth';
import { ok } from './respond';

const CHANNELS = ['POS', 'NIP_TRANSFER', 'QR'];

/**
 * Demo-only controls. They do not exist outside demo mode (404). The read-only ones and sign-in are open so the
 * demo login works; the ones that change data need ops access (or DEMO_OPEN=1).
 */
export function demoRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (open) => {
    open.addHook('preHandler', requireDemoMode(deps));

    open.get('/demo/traders', async () => ok(DEMO_TRADERS));
    open.get('/demo/clock', async () => ok(clockState(deps)));

    // "Sign in as" one of the four sandbox traders: enrols them on first use.
    open.post('/demo/sign-in', async (req) => {
      const { account } = z.object({ account: z.string().regex(/^\d{10}$/) }).parse(req.body);
      const t = DEMO_TRADERS.find((x) => x.bankAccount === account);
      if (!t) throw new AppError('NOT_A_DEMO_TRADER', 'That is not one of the demo accounts.', 404);
      const existing = deps.db.prepare('SELECT id FROM merchants WHERE bank_account = ?').get(account) as { id: string } | undefined;
      const m = existing
        ? getMerchant(deps.db, existing.id)
        : onboardMerchant(deps.db, { phone: t.phone, fullName: t.fullName, bvn: t.bvn, bankAccount: t.bankAccount, language: t.language, rateBps: 200, at: deps.clock() }).merchant;
      return ok(webMerchant(deps, m));
    });
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', requireDemo(deps));

    // Moves only the withdrawal-eligibility clock (vesting and cooldown). Sweep windows always use the real time.
    admin.post('/demo/clock', async (req) => {
      const b = z.object({ days: z.number().int().min(0).max(400) }).parse(req.body);
      setOffsetDays(deps.db, b.days);
      return ok(clockState(deps));
    });

    // "A customer pays this trader". With a real bank connected this is a real transfer from the payer account, so
    // the statement and the collector see it; otherwise it records the credit directly. Either way it counts once.
    admin.post('/demo/inflow', async (req, reply) => {
      const b = z
        .object({ merchantId: z.string().uuid().optional(), phone: z.string().optional(), amountKobo: z.number().int().min(100).max(1_000_000_000), count: z.number().int().min(1).max(5).default(1) })
        .parse(req.body);
      const m = b.merchantId ? getMerchant(deps.db, b.merchantId) : b.phone ? findMerchantByPhone(deps.db, b.phone) : null;
      if (!m || m.status !== 'ACTIVE') throw new AppError('MERCHANT_NOT_FOUND', 'No active merchant with that id.', 404);
      const results: { reference: string; recorded: boolean }[] = [];
      for (let i = 0; i < b.count; i++) {
        const stamp = `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 5)}`;
        const reference = `KOBO-IN-${stamp}`;
        let settled = true;
        if (deps.bank.payIn) {
          if (deps.config.demoPayerAccount === m.bankAccount) throw new AppError('INVALID_REQUEST', 'The payer and the trader are the same account.', 400);
          try {
            const r = await deps.bank.payIn({ sourceAccount: deps.config.demoPayerAccount, destinationAccount: m.bankAccount, amount: BigInt(b.amountKobo), reference, idempotencyKey: `demo-${stamp}` });
            settled = r.status === 'successful'; // a pending transfer is recorded by the collector once it settles
          } catch (e) {
            if ((e as { code?: string }).code) throw new AppError('BANK_UNAVAILABLE', 'The bank could not take that payment.', 502, { results });
            throw e;
          }
        }
        if (settled) recordInflow(deps, { merchantId: m.id, amount: BigInt(b.amountKobo), channel: CHANNELS[i % 3], bankReference: reference });
        results.push({ reference, recorded: settled });
      }
      return reply.status(201).send(ok({ merchantId: m.id, amountKobo: b.amountKobo, results }));
    });

    // Wipe everything and rebuild the demo traders.
    admin.post('/demo/reset', async () => ok(await seedDemo(deps)));
  });
}

const clockState = (deps: Deps) => ({ offsetDays: getOffsetDays(deps.db), active: getOffsetDays(deps.db) !== 0, now: new Date(deps.clock().getTime() + getOffsetDays(deps.db) * 86_400_000).toISOString() });
