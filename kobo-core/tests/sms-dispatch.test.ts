import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchDueSms } from '../src/sms/dispatcher';
import { enqueueSms } from '../src/sms/outbox';
import { AfricasTalkingProvider, ConsoleSmsProvider, SmsSendError } from '../src/sms/provider';
import { makeDeps, makeMerchant, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool, { config: { sms: { ...makeDeps(pool).config.sms, retryBaseMs: 1000, maxAttempts: 3 } } });
});
afterAll(() => pool.end());

const queue = async (n = 1) => {
  const m = await makeMerchant(pool);
  for (let i = 0; i < n; i++) await enqueueSms(pool, { merchantId: m.id, to: m.phone_number, kind: 'COMMAND_REPLY', body: `hello ${i}`, at: deps.clock() });
  return m;
};
const rows = async () => (await pool.query('SELECT status, attempts, last_error, provider_message_id, next_attempt_at FROM sms_outbox ORDER BY body')).rows;

describe('SMS outbox dispatcher', () => {
  it('sends queued messages and records the provider id', async () => {
    await queue(2);
    expect(await dispatchDueSms(deps)).toEqual({ sent: 2, retried: 0, failed: 0 });
    expect(deps.sms.sent.map((s) => s.body).sort()).toEqual(['hello 0', 'hello 1']);
    const r = await rows();
    expect(r.every((x) => x.status === 'SENT' && x.provider_message_id?.startsWith('console-'))).toBe(true);
    expect(await dispatchDueSms(deps)).toEqual({ sent: 0, retried: 0, failed: 0 }); // nothing left
  });

  it('dedupe keys make enqueue idempotent', async () => {
    const m = await makeMerchant(pool);
    const first = await enqueueSms(pool, { merchantId: m.id, to: m.phone_number, kind: 'SWEEP_RECEIPT', body: 'a', dedupeKey: 'receipt:1', at: deps.clock() });
    const again = await enqueueSms(pool, { merchantId: m.id, to: m.phone_number, kind: 'SWEEP_RECEIPT', body: 'a', dedupeKey: 'receipt:1', at: deps.clock() });
    expect([first, again]).toEqual([true, false]);
    await dispatchDueSms(deps);
    expect(deps.sms.sent).toHaveLength(1);
  });

  it('retries transient failures with exponential backoff, then succeeds', async () => {
    await queue();
    deps.sms.failNext(2, true);
    expect(await dispatchDueSms(deps)).toMatchObject({ retried: 1 });
    let r = (await rows())[0];
    expect(r).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(r.next_attempt_at.getTime() - deps.clock().getTime()).toBe(1000); // base delay
    expect(await dispatchDueSms(deps)).toEqual({ sent: 0, retried: 0, failed: 0 }); // not due yet

    deps.setNow(new Date(deps.clock().getTime() + 1000));
    expect(await dispatchDueSms(deps)).toMatchObject({ retried: 1 });
    r = (await rows())[0];
    expect(r.next_attempt_at.getTime() - deps.clock().getTime()).toBe(2000); // doubled

    deps.setNow(new Date(deps.clock().getTime() + 2000));
    expect(await dispatchDueSms(deps)).toMatchObject({ sent: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'SENT', attempts: 3 });
  });

  it('gives up after max attempts and marks FAILED', async () => {
    await queue();
    deps.sms.failNext(10, true);
    for (let i = 0; i < 3; i++) {
      await dispatchDueSms(deps);
      deps.setNow(new Date(deps.clock().getTime() + 60_000));
    }
    expect((await rows())[0]).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect((await rows())[0].last_error).toMatch(/carrier/);
  });

  it('a permanent rejection fails immediately', async () => {
    await queue();
    deps.sms.failNext(1, false);
    expect(await dispatchDueSms(deps)).toMatchObject({ failed: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
  });

  it('reclaims a message whose sender crashed mid-send (lease expiry)', async () => {
    await queue();
    await pool.query(`UPDATE sms_outbox SET status = 'SENDING', attempts = 1, next_attempt_at = $1`, [new Date(deps.clock().getTime() + 5 * 60_000)]);
    expect(await dispatchDueSms(deps)).toEqual({ sent: 0, retried: 0, failed: 0 }); // lease still held
    deps.setNow(new Date(deps.clock().getTime() + 5 * 60_000 + 1));
    expect(await dispatchDueSms(deps)).toMatchObject({ sent: 1 });
  });

  it('two dispatchers running at once never send the same message twice', async () => {
    await queue(30);
    const [a, b] = await Promise.all([dispatchDueSms(deps, 50), dispatchDueSms(deps, 50)]);
    expect(a.sent + b.sent).toBe(30);
    expect(deps.sms.sent).toHaveLength(30);
    expect(new Set(deps.sms.sent.map((s) => s.body)).size).toBe(30);
  });
});

describe("Africa's Talking provider", () => {
  const ok = (body: unknown, status = 201) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const accepted = { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: 101, number: '+2348031234567', status: 'Success', messageId: 'ATXid_1' }] } };

  it('posts the form with the api key to the sandbox host and returns the message id', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(accepted), { status: 201 });
    }) as unknown as typeof fetch;
    const p = new AfricasTalkingProvider('sandbox', 'KEY', 'KOBO', fetchFn);
    expect(await p.send('+2348031234567', 'hi')).toEqual({ messageId: 'ATXid_1' });
    expect(seen!.url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect((seen!.init.headers as Record<string, string>).apiKey).toBe('KEY');
    expect(String(seen!.init.body)).toBe('username=sandbox&to=%2B2348031234567&message=hi&from=KOBO');
    expect(await new AfricasTalkingProvider('kobo', 'K', '', fetchFn).send('+2348031234567', 'x')).toBeTruthy();
    expect(seen!.url).toBe('https://api.africastalking.com/version1/messaging');
  });

  it('classifies failures: carrier/5xx/network retryable, per-recipient rejection and 4xx final', async () => {
    const fail = (fetchFn: typeof fetch) => new AfricasTalkingProvider('u', 'k', '', fetchFn).send('+2348031234567', 'x').catch((e) => e);
    expect(await fail(ok({}, 503))).toMatchObject({ name: 'SmsSendError', retryable: true });
    expect(await fail((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch)).toMatchObject({ retryable: true });
    expect(await fail(ok({ SMSMessageData: { Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber' }] } }))).toMatchObject({ retryable: false });
    expect(await fail(ok({ error: 'bad key' }, 401))).toMatchObject({ retryable: false });
    expect(await fail(ok({ SMSMessageData: { Message: 'InvalidSenderId', Recipients: [] } }))).toBeInstanceOf(SmsSendError);
  });

  it('is a drop-in provider for the dispatcher', async () => {
    await queue();
    const real = new AfricasTalkingProvider('sandbox', 'k', '', ok(accepted));
    const d = { ...deps, sms: real };
    expect(await dispatchDueSms(d)).toMatchObject({ sent: 1 });
    expect((await rows())[0].provider_message_id).toBe('ATXid_1');
    void ConsoleSmsProvider;
  });
});
