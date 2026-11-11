import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { findMerchantByPhone, getMerchant, LANGUAGES, onboardMerchant, reactivateMerchant, cancelMerchant, setLanguage, type Merchant } from '../merchants/service';
import { listMessages } from '../messages/service';
import { parseNaira, parsePositiveNaira } from '../money';
import { normalizePhone } from '../phone';
import { getOpenSuggestion, respondToSuggestion } from '../smart-rate/service';
import { requestWithdrawal } from '../withdrawals/service';
import { pause, resume, setRate } from '../channels/actions';
import { webActivity, webFeed, webMerchant, webSummary } from '../web/mappers';
import { tierOf } from '../demo/traders';
import { hasOpsAccess } from './auth';
import { ok } from './respond';

const id = z.object({ id: z.string().uuid() });
const naira = z.union([z.string(), z.number()]);
const LANG = z.enum(LANGUAGES as [string, ...string[]]);
/** The sandbox accepts this one-time code (Forge guide 5.4); sign-in reuses it. */
const DEMO_OTP = '123456';

export function merchantRoutes(app: FastifyInstance, deps: Deps): void {
  // Direct enrolment for development and tests. The real sign-up is POST /merchants/onboard (BVN, name match, consent).
  app.post('/merchants', async (req: FastifyRequest, reply) => {
    if (!deps.config.demoMode && !hasOpsAccess(deps, req)) throw new AppError('UNAUTHORIZED', 'Sign-up is not open.', 401);
    const b = z
      .object({
        phone: z.string(), fullName: z.string().min(2).max(100), bvn: z.string().regex(/^\d{11}$/), bankAccount: z.string().regex(/^\d{10}$/),
        language: LANG.optional(), rateBps: z.number().int().optional(), dailyCapNaira: naira.optional(), bufferNaira: naira.optional(),
      })
      .parse(req.body);
    const phone = normalizePhone(b.phone);
    if (!phone) throw new AppError('INVALID_PHONE', 'Enter a valid Nigerian phone number.', 400);
    const { merchant } = onboardMerchant(deps.db, {
      phone, fullName: b.fullName, bvn: b.bvn, bankAccount: b.bankAccount, language: b.language as Merchant['language'] | undefined, rateBps: b.rateBps,
      dailyCap: b.dailyCapNaira === undefined ? undefined : parsePositiveNaira(b.dailyCapNaira),
      buffer: b.bufferNaira === undefined ? undefined : parseNaira(b.bufferNaira),
      at: deps.clock(),
    });
    return reply.status(201).send(ok(webMerchant(deps, merchant)));
  });

  app.get('/merchants/:id/summary', async (req) => ok(await webSummary(deps, id.parse(req.params).id)));
  app.get('/merchants/:id/activity', async (req) => ok(webActivity(deps, id.parse(req.params).id)));
  app.get('/merchants/:id/feed', async (req) => ok(webFeed(deps, id.parse(req.params).id)));

  // pauseHours: 0 resumes. Returns the fresh summary so the screen can redraw from one response.
  app.patch('/merchants/:id/settings', async (req) => {
    const { id: mid } = id.parse(req.params);
    const b = z
      .object({ rateBps: z.number().int().optional(), language: LANG.optional(), pauseHours: z.number().min(0).max(24 * 365).optional(), cancel: z.literal(true).optional(), reactivate: z.literal(true).optional() })
      .strict()
      .parse(req.body);
    const m = getMerchant(deps.db, mid);
    if (b.reactivate) reactivateMerchant(deps.db, mid, deps.clock());
    else if (m.status === 'CANCELLED') throw new AppError('PLAN_CANCELLED', 'This plan is cancelled. Reactivate it first.', 409);
    if (b.rateBps !== undefined) setRate(deps, mid, b.rateBps);
    if (b.language !== undefined) setLanguage(deps.db, mid, b.language as Merchant['language']);
    if (b.pauseHours !== undefined) b.pauseHours === 0 ? resume(deps, mid) : pause(deps, mid, b.pauseHours);
    if (b.cancel) cancelMerchant(deps.db, mid, deps.clock());
    return ok(await webSummary(deps, mid));
  });

  app.get('/merchants/:id/messages', async (req) => {
    const { id: mid } = id.parse(req.params);
    getMerchant(deps.db, mid);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return ok({ messages: listMessages(deps.db, mid, limit) });
  });

  // A refusal is a normal answer, not an error: ok:false with the same sentence USSD and SMS show.
  app.post('/withdrawals', async (req) => {
    // The app sends amountKobo for the Emergency Pot. `pot` and amountNaira exist so a Retirement Pot request is
    // answered with the "locked until 50" refusal rather than ignored.
    const b = z
      .object({ merchantId: z.string().uuid(), amountKobo: z.number().int().positive().optional(), amountNaira: naira.optional(), pot: z.enum(['EMERGENCY', 'RETIREMENT']).default('EMERGENCY') })
      .refine((x) => (x.amountKobo === undefined) !== (x.amountNaira === undefined), { message: 'send exactly one of amountKobo or amountNaira' })
      .parse(req.body);
    getMerchant(deps.db, b.merchantId);
    const amount = b.amountKobo !== undefined ? BigInt(b.amountKobo) : parsePositiveNaira(b.amountNaira!);
    const r = await requestWithdrawal(deps, b.merchantId, amount, b.pot);
    return ok({ ok: r.accepted, message: r.message });
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

  // Sign-up helpers. The account name comes from the bank's name enquiry.
  app.get('/identity/resolve', async (req) => {
    const { account } = z.object({ account: z.string().regex(/^\d{10}$/, 'account must be 10 digits') }).parse(req.query);
    const ne = await deps.bank.nameEnquiry(account).catch((e) => {
      if ((e as { code?: string }).code === 'ACCOUNT_NOT_FOUND') throw new AppError('ACCOUNT_NOT_FOUND', 'We could not find that account.', 404);
      throw new AppError('BANK_UNAVAILABLE', 'Bank check failed, try again.', 502);
    });
    return ok({ name: ne.accountName, tier: ne.kycLevel ?? tierOf(account) });
  });

  app.post('/auth/verify-otp', async (req) => {
    const b = z.object({ phone: z.string(), code: z.string() }).parse(req.body);
    if (b.code !== DEMO_OTP) throw new AppError('INVALID_OTP', 'That code is not right.', 401);
    const phone = normalizePhone(b.phone);
    const m = phone ? findMerchantByPhone(deps.db, phone) : null;
    return ok({ merchantId: m?.id ?? null });
  });
}
