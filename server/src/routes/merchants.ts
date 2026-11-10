import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { cancelMerchant, getMerchant, LANGUAGES, onboardMerchant, setLanguage, type Merchant } from '../merchants/service';
import { merchantSummary } from '../merchants/summary';
import { listMessages } from '../messages/service';
import { parseNaira, parsePositiveNaira } from '../money';
import { normalizePhone } from '../phone';
import { getOpenSuggestion, respondToSuggestion } from '../smart-rate/service';
import { requestWithdrawal, listWithdrawals } from '../withdrawals/service';
import { maskAccount, pause, resume, setRate } from '../channels/actions';
import { mapSweep } from '../sweeps/engine';
import { listInflows } from '../inflows/service';
import { hasOpsAccess } from './auth';
import { ok } from './respond';

const id = z.object({ id: z.string().uuid() });
const naira = z.union([z.string(), z.number()]);

/** A merchant as the app sees it: the bank account is masked and nothing secret is included. */
const publicMerchant = (m: Merchant) => ({
  id: m.id, phone: m.phone, fullName: m.fullName, bankAccountMasked: maskAccount(m.bankAccount), language: m.language,
  rateBps: m.rateBps, dailyCap: m.dailyCap, buffer: m.buffer, pausedUntil: m.pausedUntil, status: m.status, createdAt: m.createdAt,
});

export function merchantRoutes(app: FastifyInstance, deps: Deps): void {
  // Sign-up. The verified flow (BVN and name enquiry through the bank) is Abiodun's: it should call onboardMerchant
  // after its checks. Until then this is open in demo mode and ops-only otherwise.
  app.post('/merchants', async (req: FastifyRequest, reply) => {
    if (!deps.config.demoMode && !hasOpsAccess(deps, req)) throw new AppError('UNAUTHORIZED', 'Sign-up is not open.', 401);
    const b = z
      .object({
        phone: z.string(), full_name: z.string().min(2).max(100), bvn: z.string().regex(/^\d{11}$/), bank_account: z.string().regex(/^\d{10}$/),
        language: z.enum(LANGUAGES as [string, ...string[]]).optional(), rate_bps: z.number().int().optional(),
        daily_cap_naira: naira.optional(), buffer_naira: naira.optional(),
      })
      .parse(req.body);
    const phone = normalizePhone(b.phone);
    if (!phone) throw new AppError('INVALID_PHONE', 'Enter a valid Nigerian phone number.', 400);
    const { merchant, rsaPin } = onboardMerchant(deps.db, {
      phone, fullName: b.full_name, bvn: b.bvn, bankAccount: b.bank_account, language: b.language as Merchant['language'] | undefined, rateBps: b.rate_bps,
      dailyCap: b.daily_cap_naira === undefined ? undefined : parsePositiveNaira(b.daily_cap_naira),
      buffer: b.buffer_naira === undefined ? undefined : parseNaira(b.buffer_naira),
      at: deps.clock(),
    });
    return reply.status(201).send(ok({ merchant: publicMerchant(merchant), rsaPin }));
  });

  app.get('/merchants/:id/summary', async (req) => {
    const { id: mid } = id.parse(req.params);
    const s = merchantSummary(deps, mid);
    const { merchant, ...rest } = s;
    return ok({ merchant: publicMerchant(merchant), ...rest, openSuggestion: getOpenSuggestion(deps, mid), collectionAccount: deps.config.collectionLabel });
  });

  app.patch('/merchants/:id/settings', async (req) => {
    const { id: mid } = id.parse(req.params);
    const b = z
      .object({ rate_bps: z.number().int().optional(), paused: z.boolean().optional(), pause_hours: z.number().positive().max(24 * 365).optional(), language: z.string().optional(), cancel: z.literal(true).optional() })
      .strict()
      .parse(req.body);
    if (getMerchant(deps.db, mid).status === 'CANCELLED') throw new AppError('PLAN_CANCELLED', 'This plan is cancelled.', 409);
    if (b.rate_bps !== undefined) setRate(deps, mid, b.rate_bps);
    if (b.language !== undefined) setLanguage(deps.db, mid, b.language as Merchant['language']);
    if (b.paused === true) pause(deps, mid, b.pause_hours);
    if (b.paused === false) resume(deps, mid);
    if (b.cancel) cancelMerchant(deps.db, mid, deps.clock());
    return ok({ merchant: publicMerchant(getMerchant(deps.db, mid)) });
  });

  app.get('/merchants/:id/messages', async (req) => {
    const { id: mid } = id.parse(req.params);
    getMerchant(deps.db, mid);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return ok({ messages: listMessages(deps.db, mid, limit) });
  });

  app.get('/merchants/:id/sweeps', async (req) => {
    const { id: mid } = id.parse(req.params);
    getMerchant(deps.db, mid);
    const rows = deps.db.prepare('SELECT * FROM sweeps WHERE merchant_id = ? ORDER BY sweep_date DESC LIMIT 60').all(mid) as any[];
    return ok({ sweeps: rows.map(mapSweep) });
  });

  app.get('/merchants/:id/inflows', async (req) => {
    const { id: mid } = id.parse(req.params);
    getMerchant(deps.db, mid);
    return ok({ inflows: listInflows(deps, mid) });
  });

  app.get('/merchants/:id/withdrawals', async (req) => {
    const { id: mid } = id.parse(req.params);
    getMerchant(deps.db, mid);
    return ok({ withdrawals: listWithdrawals(deps.db, mid) });
  });

  // A refusal is a normal answer, not an error: 200 with accepted:false and the same sentence USSD and SMS show.
  app.post('/withdrawals', async (req) => {
    const b = z.object({ merchant_id: z.string().uuid(), amount_naira: naira, pot: z.enum(['EMERGENCY', 'RETIREMENT']).default('EMERGENCY') }).parse(req.body);
    getMerchant(deps.db, b.merchant_id);
    const r = await requestWithdrawal(deps, b.merchant_id, parsePositiveNaira(b.amount_naira), b.pot);
    return ok({ accepted: r.accepted, message: r.message, withdrawal: r.withdrawal });
  });

  app.get('/merchants/:id/suggestion', async (req) => {
    const { id: mid } = id.parse(req.params);
    getMerchant(deps.db, mid);
    return ok({ suggestion: getOpenSuggestion(deps, mid) });
  });

  app.post('/merchants/:id/suggestion/respond', async (req) => {
    const { id: mid } = id.parse(req.params);
    const b = z.object({ decision: z.enum(['accept', 'decline']) }).parse(req.body);
    getMerchant(deps.db, mid);
    const r = respondToSuggestion(deps, { merchantId: mid, decision: b.decision === 'accept' ? 'ACCEPT' : 'DECLINE' });
    if (r.outcome === 'NONE') throw new AppError('NO_OPEN_SUGGESTION', 'There is no suggestion waiting.', 404);
    return ok(r);
  });
}
