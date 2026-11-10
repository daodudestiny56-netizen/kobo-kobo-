import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { addMonthsToInstant } from '../src/time';
import { AfricasTalkingVoiceProvider, VoiceCallError } from '../src/voice/provider';
import { sayXml, spokenBalance, spokenNaira } from '../src/voice/script';
import { dispatchDueCalls } from '../src/voice/service';
import { DURING, makeDeps, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool, { now: DURING, config: { voice: { ...makeDeps(pool).config.voice, retryBaseMs: 1000, maxAttempts: 3, callTimeoutMs: 60_000 } } });
  app = buildServer(deps);
});
afterAll(() => pool.end());

const vested = { emergency: '1084.50', retirement: '1000.00', firstContributionAt: addMonthsToInstant(DURING, -4) };
const ussd = (phone: string, text: string) => app.inject({ method: 'POST', url: '/api/v1/ussd', payload: { phoneNumber: phone, text } });
const row = async () => (await pool.query('SELECT id, status, attempts, last_error, provider_call_id, served_at FROM voice_callback_requests')).rows[0];
const advance = (ms: number) => deps.setNow(new Date(deps.clock().getTime() + ms));
const webhook = (body: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/voice/callback', payload: body });
const texts = async () => (await pool.query("SELECT body FROM sms_outbox ORDER BY created_at")).rows.map((r) => r.body as string);

describe('spoken text', () => {
  it('speaks naira, not the letter N', () => {
    expect(spokenNaira(108_450n)).toBe('1,084 naira, 50 kobo');
    expect(spokenNaira(36_800_00n)).toBe('36,800 naira');
    expect(spokenNaira(0n)).toBe('0 naira');
  });

  it('English and Pidgin scripts, and XML is escaped', () => {
    const v = { name: 'Ngozi Okafor', total: 200_000n, emergency: 100_000n, retirement: 100_000n, eligibility: { eligible: true } };
    expect(spokenBalance('en', v)).toContain('Hello Ngozi. This is Kobo Kobo. Your total pension savings are 2,000 naira.');
    expect(spokenBalance('en', v)).toContain('Eligible');
    expect(spokenBalance('pidgin', v)).toContain('Na Kobo Kobo dey talk. All your pension savings na 2,000 naira.');
    expect(spokenBalance('yoruba', v)).toContain('This is Kobo Kobo'); // falls back to English
    expect(sayXml(`Tom & "Jerry" <b>`)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman" playBeep="false">Tom &amp; &quot;Jerry&quot; &lt;b&gt;</Say></Response>');
  });
});

describe('USSD 6 queues one call request', () => {
  it('tapping twice (or concurrently) creates a single open request', async () => {
    const m = await makeTrader(pool, { pension: vested });
    await Promise.all([ussd(m.phone_number, '6'), ussd(m.phone_number, '6'), ussd(m.phone_number, '6')]);
    expect((await pool.query('SELECT count(*)::int n FROM voice_callback_requests')).rows[0].n).toBe(1);
  });
});

describe('dispatching calls', () => {
  it('places the call with the request id and waits for the answer', async () => {
    const m = await makeTrader(pool, { pension: vested });
    await ussd(m.phone_number, '6');
    expect(await dispatchDueCalls(deps)).toEqual({ placed: 1, retried: 0, failed: 0 });
    const r = await row();
    expect(deps.voice.calls).toEqual([{ to: m.phone_number, requestId: r.id, callId: 'console-call-1' }]);
    expect(r).toMatchObject({ status: 'CALLING', attempts: 1, provider_call_id: 'console-call-1' });
    expect(await dispatchDueCalls(deps)).toEqual({ placed: 0, retried: 0, failed: 0 }); // not due until the call times out
  });

  it('a carrier failure retries with backoff, then succeeds', async () => {
    const m = await makeTrader(pool, { pension: vested });
    await ussd(m.phone_number, '6');
    deps.voice.failNext(1);
    expect(await dispatchDueCalls(deps)).toMatchObject({ retried: 1 });
    expect(await row()).toMatchObject({ status: 'PENDING', attempts: 1, last_error: expect.stringContaining('carrier') });
    expect(await dispatchDueCalls(deps)).toEqual({ placed: 0, retried: 0, failed: 0 });
    advance(1000);
    expect(await dispatchDueCalls(deps)).toMatchObject({ placed: 1 });
    expect(await row()).toMatchObject({ status: 'CALLING', attempts: 2 });
  });

  it('a permanent rejection fails at once and texts the balance instead', async () => {
    const m = await makeTrader(pool, { pension: vested });
    await ussd(m.phone_number, '6');
    deps.voice.failNext(1, false);
    expect(await dispatchDueCalls(deps)).toMatchObject({ failed: 1 });
    expect(await row()).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(await texts()).toEqual([expect.stringMatching(/^We tried to call you but could not reach you\. Kobo Kobo: Total saved is N2,084\./)]);
  });

  it('gives up after maxAttempts of transient failures and texts the balance once', async () => {
    const m = await makeTrader(pool, { pension: vested });
    await ussd(m.phone_number, '6');
    deps.voice.failNext(10);
    for (let i = 0; i < 4; i++) {
      await dispatchDueCalls(deps);
      advance(60_000);
    }
    expect(await row()).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await texts()).toHaveLength(1);
  });

  it('an unanswered call times out, is retried, and finally falls back to a text', async () => {
    const m = await makeTrader(pool, { pension: vested });
    await ussd(m.phone_number, '6');
    for (let i = 0; i < 3; i++) {
      await dispatchDueCalls(deps);
      advance(61_000); // call timeout passes with no answer
    }
    expect(deps.voice.calls).toHaveLength(3);
    expect(await dispatchDueCalls(deps)).toMatchObject({ failed: 1 });
    expect(await row()).toMatchObject({ status: 'FAILED', last_error: 'no answer after all attempts' });
    expect(await texts()).toHaveLength(1);
    // the trader can ask again afterwards
    await ussd(m.phone_number, '6');
    expect((await pool.query("SELECT count(*)::int n FROM voice_callback_requests WHERE status = 'PENDING'")).rows[0].n).toBe(1);
  });

  it('two dispatchers at once place each call exactly once', async () => {
    for (let i = 0; i < 12; i++) {
      const m = await makeTrader(pool, { pension: vested });
      await ussd(m.phone_number, '6');
    }
    const [a, b] = await Promise.all([dispatchDueCalls(deps, 50), dispatchDueCalls(deps, 50)]);
    expect(a.placed + b.placed).toBe(12);
    expect(new Set(deps.voice.calls.map((c) => c.requestId)).size).toBe(12);
  });
});

describe("Africa's Talking voice webhook", () => {
  const callPlaced = async (o: Parameters<typeof makeTrader>[1] = {}) => {
    const m = await makeTrader(pool, { pension: vested, ...o });
    await ussd(m.phone_number, '6');
    await dispatchDueCalls(deps);
    return { m, requestId: (await row()).id as string };
  };

  it('answered call: speaks the balance as XML and completes the request', async () => {
    const { m, requestId } = await callPlaced({ name: 'Ngozi Okafor' });
    const res = await webhook({ isActive: '1', direction: 'Outbound', clientRequestId: requestId, destinationNumber: m.phone_number, sessionId: 'AT1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.body).toContain('<Say voice="woman" playBeep="false">Hello Ngozi. This is Kobo Kobo. Your total pension savings are 2,084 naira, 50 kobo.');
    expect(res.body).toContain('Your Emergency Pot has 1,084 naira, 50 kobo. Eligible.');
    expect(await row()).toMatchObject({ status: 'DONE' });
    expect((await row()).served_at).toEqual(DURING);
    // the same webhook delivered again still speaks, and nothing breaks
    expect((await webhook({ isActive: '1', clientRequestId: requestId })).statusCode).toBe(200);
    expect((await webhook({ isActive: '0', clientRequestId: requestId })).statusCode).toBe(204);
    expect((await pool.query('SELECT completed_at FROM voice_callback_requests')).rows[0].completed_at).toEqual(DURING);
    expect(await texts()).toEqual([]);
  });

  it('Pidgin trader hears Pidgin', async () => {
    const { requestId } = await callPlaced({ language: 'pidgin' });
    expect((await webhook({ isActive: '1', clientRequestId: requestId })).body).toContain('Na Kobo Kobo dey talk');
  });

  it('call ended without an answer: queued again with backoff, and finally a text', async () => {
    const { requestId } = await callPlaced();
    expect((await webhook({ isActive: '0', clientRequestId: requestId, callSessionState: 'NoAnswer' })).statusCode).toBe(204);
    expect(await row()).toMatchObject({ status: 'PENDING', attempts: 1, last_error: expect.stringContaining('NoAnswer') });
    advance(1000);
    await dispatchDueCalls(deps);
    await webhook({ isActive: '0', clientRequestId: requestId, callSessionState: 'Busy' });
    advance(2000);
    await dispatchDueCalls(deps);
    await webhook({ isActive: '0', clientRequestId: requestId, callSessionState: 'NoAnswer' });
    expect(await row()).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await texts()).toHaveLength(1);
  });

  it('a trader dialling in is recognised by caller number; strangers are told to sign up', async () => {
    const m = await makeTrader(pool, { pension: vested, name: 'Bola Ade' });
    const known = await webhook({ isActive: '1', direction: 'Inbound', callerNumber: m.phone_number });
    expect(known.body).toContain('Hello Bola. This is Kobo Kobo.');
    const stranger = await webhook({ isActive: '1', direction: 'Inbound', callerNumber: '+2348099999999' });
    expect(stranger.body).toContain('not registered');
    expect((await pool.query('SELECT count(*)::int n FROM voice_callback_requests')).rows[0].n).toBe(0);
  });

  it('ignores a malformed request id rather than failing the call', async () => {
    const m = await makeTrader(pool, { pension: vested });
    const res = await webhook({ isActive: '1', direction: 'Inbound', callerNumber: m.phone_number, clientRequestId: "x'; DROP TABLE merchants;--" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Hello');
  });

  it('a merchant with no RSA gets a polite apology, not a crash', async () => {
    const { makeMerchant } = await import('./helpers');
    const m = await makeMerchant(pool);
    const res = await webhook({ isActive: '1', direction: 'Inbound', callerNumber: m.phone_number });
    expect(res.body).toContain('could not read your balance right now');
  });

  it('is guarded by the webhook token like the other telco endpoints', async () => {
    const guarded = buildServer(makeDeps(pool, { now: DURING, config: { webhookToken: 'tok', serviceToken: '' } }));
    expect((await guarded.inject({ method: 'POST', url: '/api/v1/voice/callback', payload: { isActive: '0' } })).statusCode).toBe(401);
    expect((await guarded.inject({ method: 'POST', url: '/api/v1/voice/callback?token=tok', payload: { isActive: '0' } })).statusCode).toBe(204);
    await guarded.close();
  });

  it('accepts the form encoding Africa\'s Talking really sends', async () => {
    const { requestId } = await callPlaced();
    const res = await app.inject({ method: 'POST', url: '/api/v1/voice/callback', payload: `isActive=1&sessionId=ATVId_1&direction=Outbound&clientRequestId=${requestId}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.body).toContain('<Response><Say');
  });
});

describe("Africa's Talking voice provider", () => {
  const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const queued = { entries: [{ phoneNumber: '+2348031234567', status: 'Queued' }], errorMessage: 'None' };

  it('posts the call with our request id to the right host', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(queued), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AfricasTalkingVoiceProvider('sandbox', 'KEY', '+2342001234567', f);
    expect(await p.placeCall('+2348031234567', { requestId: 'req-1' })).toEqual({ callId: 'req-1' });
    expect(seen!.url).toBe('https://voice.sandbox.africastalking.com/call');
    expect((seen!.init.headers as Record<string, string>).apiKey).toBe('KEY');
    expect(String(seen!.init.body)).toBe('username=sandbox&from=%2B2342001234567&to=%2B2348031234567&clientRequestId=req-1');
    await new AfricasTalkingVoiceProvider('kobo', 'K', '+234', f).placeCall('+2348031234567', { requestId: 'r' });
    expect(seen!.url).toBe('https://voice.africastalking.com/call');
  });

  it('classifies failures', async () => {
    const fail = (f: typeof fetch) => new AfricasTalkingVoiceProvider('u', 'k', '+234', f).placeCall('+2348031234567', { requestId: 'r' }).catch((e) => e);
    expect(await fail(json({}, 503))).toMatchObject({ name: 'VoiceCallError', retryable: true });
    expect(await fail((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch)).toMatchObject({ retryable: true });
    expect(await fail(json({ error: 'bad key' }, 401))).toMatchObject({ retryable: false });
    expect(await fail(json({ entries: [{ status: 'InvalidPhoneNumber' }], errorMessage: 'None' }))).toMatchObject({ retryable: false });
    expect(await fail(json({ entries: [{ status: 'Busy: try again' }], errorMessage: 'None' }))).toMatchObject({ retryable: true });
    expect(await fail(json({ entries: [], errorMessage: 'InsufficientBalance' }))).toBeInstanceOf(VoiceCallError);
  });
});
