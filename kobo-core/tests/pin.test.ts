import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { addMonthsToInstant } from '../src/time';
import { changePin, pinProblem, setPin, verifyPin } from '../src/security/pin';
import { DURING, makeDeps, makeMerchant, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool, { now: DURING });
  app = buildServer(deps);
});
afterAll(() => pool.end());

const vested = { emergency: '500.00', retirement: '500.00', firstContributionAt: addMonthsToInstant(DURING, -4) };
const row = async (id: string) => (await pool.query('SELECT pin_hash, pin_failed_attempts, pin_locked_until FROM merchants WHERE id=$1', [id])).rows[0];
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e.code as string);
const ussd = async (phone: string, text: string) =>
  (await app.inject({ method: 'POST', url: '/api/v1/ussd', payload: { phoneNumber: phone, text } })).body;

describe('PIN rules', () => {
  it('accepts four ordinary digits and rejects weak or malformed ones', () => {
    expect(pinProblem('7391')).toBeNull();
    for (const bad of ['123', '12345', 'abcd', '12 4', '']) expect(pinProblem(bad)).toBe('FORMAT');
    for (const weak of ['0000', '1111', '1234', '4321', '0123', '9876']) expect(pinProblem(weak)).toBe('WEAK');
    expect(pinProblem('4567', '+2348031234567')).toBe('WEAK'); // end of the phone number
  });
});

describe('PIN storage and verification', () => {
  it('stores only a salted hash, never the PIN, and texts the trader', async () => {
    const m = await makeMerchant(pool);
    await setPin(deps, m.id, '7391');
    const r = await row(m.id);
    expect(r.pin_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(r.pin_hash).not.toContain('7391');
    await verifyPin(deps, m.id, '7391');
    const sms = (await pool.query("SELECT kind, body FROM sms_outbox")).rows;
    expect(sms).toEqual([{ kind: 'SECURITY', body: expect.stringContaining('PIN is set') }]);
  });

  it('two merchants with the same PIN get different hashes (per-PIN salt)', async () => {
    const a = await makeMerchant(pool);
    const b = await makeMerchant(pool);
    await setPin(deps, a.id, '7391');
    await setPin(deps, b.id, '7391');
    expect((await row(a.id)).pin_hash).not.toBe((await row(b.id)).pin_hash);
  });

  it('a pepper change invalidates PINs (the pepper really is mixed in)', async () => {
    const m = await makeMerchant(pool);
    await setPin(deps, m.id, '7391');
    const other = { ...deps, config: { ...deps.config, pin: { ...deps.config.pin, pepper: 'different' } } };
    expect(await code(verifyPin(other, m.id, '7391'))).toBe('PIN_INVALID');
    await verifyPin(deps, m.id, '7391');
  });

  it('refuses a second set without reset; reset replaces it and clears a lock', async () => {
    const m = await makeMerchant(pool);
    await setPin(deps, m.id, '7391');
    expect(await code(setPin(deps, m.id, '2846'))).toBe('PIN_ALREADY_SET');
    for (let i = 0; i < 3; i++) await code(verifyPin(deps, m.id, '0000'));
    expect(await code(verifyPin(deps, m.id, '7391'))).toBe('PIN_LOCKED');
    await setPin(deps, m.id, '2846', { reset: true });
    await verifyPin(deps, m.id, '2846');
    expect((await pool.query("SELECT body FROM sms_outbox WHERE body LIKE '%changed%'")).rowCount).toBe(1);
  });

  it('PIN_NOT_SET, PIN_FORMAT and PIN_TOO_WEAK are distinct errors', async () => {
    const m = await makeMerchant(pool);
    expect(await code(verifyPin(deps, m.id, '7391'))).toBe('PIN_NOT_SET');
    expect(await code(setPin(deps, m.id, '12'))).toBe('PIN_FORMAT');
    expect(await code(setPin(deps, m.id, '1111'))).toBe('PIN_TOO_WEAK');
  });
});

describe('lockout', () => {
  it('counts down attempts, locks on the third miss, texts the trader, and unlocks after the lock time', async () => {
    const m = await makeMerchant(pool, { pin: '7391' });
    const attempt = (pin: string) => verifyPin(deps, m.id, pin).catch((e) => e);
    expect((await attempt('0000')).details).toEqual({ attempts_remaining: 2 });
    expect((await attempt('0001')).details).toEqual({ attempts_remaining: 1 });
    const locked = await attempt('0002');
    expect(locked.code).toBe('PIN_LOCKED');
    expect(locked.details.minutes).toBe(30);
    // even the right PIN is refused while locked, and does not extend the lock
    expect((await attempt('7391')).code).toBe('PIN_LOCKED');
    expect((await pool.query("SELECT body FROM sms_outbox WHERE kind='SECURITY'")).rows[0].body).toContain('locked for 30 minutes');

    deps.setNow(new Date(DURING.getTime() + 31 * 60_000));
    await verifyPin(deps, m.id, '7391');
    expect(await row(m.id)).toMatchObject({ pin_failed_attempts: 0, pin_locked_until: null });
  });

  it('a correct PIN resets the miss counter', async () => {
    const m = await makeMerchant(pool, { pin: '7391' });
    await code(verifyPin(deps, m.id, '0000'));
    await code(verifyPin(deps, m.id, '0000'));
    await verifyPin(deps, m.id, '7391');
    expect((await row(m.id)).pin_failed_attempts).toBe(0);
    expect((await verifyPin(deps, m.id, '0000').catch((e) => e)).details.attempts_remaining).toBe(2);
  });

  it('parallel guesses cannot beat the counter', async () => {
    const m = await makeMerchant(pool, { pin: '7391' });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => code(verifyPin(deps, m.id, `00${String(i).padStart(2, '0')}`))));
    expect(results.filter((r) => r === 'PIN_INVALID')).toHaveLength(2);
    expect(results.filter((r) => r === 'PIN_LOCKED')).toHaveLength(8);
  });

  it('changePin needs the old PIN, a different new PIN, and a strong one', async () => {
    const m = await makeMerchant(pool, { pin: '7391' });
    expect(await code(changePin(deps, m.id, '0000', '2846'))).toBe('PIN_INVALID');
    expect(await code(changePin(deps, m.id, '7391', '7391'))).toBe('PIN_UNCHANGED');
    expect(await code(changePin(deps, m.id, '7391', '1111'))).toBe('PIN_TOO_WEAK');
    await changePin(deps, m.id, '7391', '2846');
    await verifyPin(deps, m.id, '2846');
    expect(await code(verifyPin(deps, m.id, '7391'))).toBe('PIN_INVALID');
  });
});

describe('PIN over HTTP', () => {
  it('set / verify / change / status endpoints', async () => {
    const m = await makeMerchant(pool);
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1/merchants/${m.id}/${url}`, payload });
    expect((await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/pin` })).json()).toEqual({ pin_set: false });
    expect((await post('pin', { pin: '7391' })).statusCode).toBe(204);
    expect((await post('pin', { pin: '2846' })).statusCode).toBe(409);
    expect((await post('pin', { pin: '2846', reset: true })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/pin` })).json()).toEqual({ pin_set: true });
    expect((await post('pin/verify', { pin: '2846' })).json()).toEqual({ valid: true });
    const bad = await post('pin/verify', { pin: '0000' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toMatchObject({ code: 'PIN_INVALID', details: { attempts_remaining: 2 } });
    expect((await post('pin/change', { old_pin: '2846', new_pin: '5937' })).statusCode).toBe(204);
    expect((await post('pin', { pin: 'x' })).statusCode).toBe(400);
  });

  it('POST /withdrawals requires the PIN: missing, wrong and locked are all refused before money moves', async () => {
    const m = await makeTrader(pool, { pin: '7391', pension: vested });
    const w = (pin?: string) => app.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount: '100.00', ...(pin ? { pin } : {}) } });
    expect((await w()).statusCode).toBe(401);
    expect((await w('0000')).statusCode).toBe(401);
    expect((await w('0001')).statusCode).toBe(423); // third miss counts the first (missing) one
    expect((await w('7391')).statusCode).toBe(423);
    expect(deps.executor.calls.credit).toBe(0);
    deps.setNow(new Date(DURING.getTime() + 31 * 60_000));
    expect((await w('7391')).statusCode).toBe(201);
  });

  it('a merchant with no PIN cannot withdraw over HTTP (422), unless the requirement is switched off', async () => {
    const m = await makeTrader(pool, { pension: vested });
    const res = await app.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount: '100.00' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PIN_NOT_SET');
    const lax = buildServer(makeDeps(pool, { now: DURING, config: { pin: { ...deps.config.pin, withdrawalRequired: false } } }));
    expect((await lax.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount: '100.00' } })).statusCode).toBe(201);
    await lax.close();
  });
});

describe('PIN on USSD', () => {
  it('withdrawal asks for the PIN last, and a wrong PIN moves nothing', async () => {
    const m = await makeTrader(pool, { pin: '7391', pension: vested });
    expect(await ussd(m.phone_number, '5*100*1')).toBe('CON Enter your 4-digit PIN to confirm:');
    expect(await ussd(m.phone_number, '5*100*1*0000')).toBe('END Wrong PIN. 2 tries left. Nothing was withdrawn.');
    expect(await ussd(m.phone_number, '5*100*1*0001')).toBe('END Wrong PIN. 1 try left. Nothing was withdrawn.');
    expect(await ussd(m.phone_number, '5*100*1*0002')).toBe('END PIN locked for 30 minutes after too many wrong tries.');
    expect(await ussd(m.phone_number, '5*100*1*7391')).toMatch(/^END PIN locked for \d+ minutes/);
    expect(deps.executor.calls.credit).toBe(0);
    deps.setNow(new Date(DURING.getTime() + 31 * 60_000));
    expect(await ussd(m.phone_number, '5*100*1*7391')).toMatch(/^END N100 is on its way/);
  });

  it('a PIN of 0 or 99 typed as digits is not mistaken for back/home (PINs are 4 digits)', async () => {
    const m = await makeTrader(pool, { pin: '7391', pension: vested });
    expect(await ussd(m.phone_number, '5*100*1*7391')).toMatch(/^END N100/);
  });

  it('no PIN yet: USSD cannot create one (SIM-swap safety) and says to use the app', async () => {
    const m = await makeTrader(pool, { pension: vested });
    expect(await ussd(m.phone_number, '5')).toBe('END Set your Kobo Kobo PIN in the app first. You need it to withdraw or change PIN.');
    expect(await ussd(m.phone_number, '7')).toMatch(/^END Set your Kobo Kobo PIN in the app first/);
  });

  it('Change PIN: current -> new -> confirm, with fail-fast checks', async () => {
    const m = await makeTrader(pool, { pin: '7391', pension: vested });
    expect(await ussd(m.phone_number, '7')).toBe('CON Enter your current 4-digit PIN:\n0. Back');
    expect(await ussd(m.phone_number, '7*7391')).toBe('CON Enter a new 4-digit PIN:\n0. Back');
    expect(await ussd(m.phone_number, '7*7391*1111')).toMatch(/^END That PIN is too easy to guess/);
    expect(await ussd(m.phone_number, '7*7391*12')).toMatch(/^END A PIN is exactly 4 digits/);
    expect(await ussd(m.phone_number, '7*7391*7391')).toMatch(/^END New PIN must be different/);
    expect(await ussd(m.phone_number, '7*7391*2846')).toBe('CON Enter the new PIN again:\n0. Back');
    expect(await ussd(m.phone_number, '7*7391*2846*2847')).toMatch(/^END The two PINs did not match/);
    expect(await ussd(m.phone_number, '7*0000')).toMatch(/^END Wrong PIN. 2 tries left/);
    await verifyPin(deps, m.id, '7391'); // unchanged so far
    expect(await ussd(m.phone_number, '7*7391*2846*2846')).toBe('END Your PIN has been changed. We sent you a text.');
    await verifyPin(deps, m.id, '2846');
    expect((await pool.query("SELECT body FROM sms_outbox WHERE body LIKE '%PIN was changed%'")).rowCount).toBe(1);
  });

  it('Pidgin PIN screens', async () => {
    const m = await makeTrader(pool, { pin: '7391', language: 'pidgin', pension: vested });
    expect(await ussd(m.phone_number, '5*100*1')).toBe('CON Put your 4-digit PIN to confirm:');
    expect(await ussd(m.phone_number, '5*100*1*0000')).toBe('END PIN no correct. 2 chances remain. Nothing comot.');
    expect(await ussd(m.phone_number, '7')).toBe('CON Put your current 4-digit PIN:\n0. Back');
    const none = await makeTrader(pool, { language: 'pidgin', pension: vested });
    expect(await ussd(none.phone_number, '5')).toMatch(/^END Set your Kobo Kobo PIN for the app first/);
  });
});
