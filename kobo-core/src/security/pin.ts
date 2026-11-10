import { randomBytes, scrypt as scryptCb, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Deps } from '../deps';
import { withTx } from '../db/pool';
import { AppError } from '../errors';
import { enqueueSms } from '../sms/outbox';
import { pinChangedNotice, pinLockedNotice, pinSetNotice } from '../sms/templates';

const scrypt = promisify(scryptCb) as (pw: Buffer, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };

export const PIN_LENGTH = 4;

/** The PIN is never stored. We keep scrypt(HMAC(pepper, pin), salt) with the parameters embedded for future upgrades. */
export async function hashPin(pin: string, pepper: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pepperPin(pin, pepper), salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const pepperPin = (pin: string, pepper: string) => createHmac('sha256', pepper).update(pin).digest();

async function matches(pin: string, stored: string, pepper: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pepperPin(pin, pepper), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Rejects PINs that are easy to guess: wrong shape, repeated digits, straight runs, or the end of the phone number. */
export function pinProblem(pin: string, phone?: string): 'FORMAT' | 'WEAK' | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return 'FORMAT';
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]);
  if (steps.every((s) => s === 0)) return 'WEAK';
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'WEAK';
  if (phone && phone.replace(/\D/g, '').endsWith(pin)) return 'WEAK';
  return null;
}

function assertAcceptable(pin: string, phone?: string): void {
  const problem = pinProblem(pin, phone);
  if (problem === 'FORMAT') throw new AppError('PIN_FORMAT', `PIN must be exactly ${PIN_LENGTH} digits.`, 400);
  if (problem === 'WEAK') throw new AppError('PIN_TOO_WEAK', 'Choose a PIN that is not a repeat, a run like 1234, or the end of your phone number.', 422);
}

interface PinRow {
  phone_number: string;
  preferred_language: string;
  pin_hash: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
}

async function loadPinRow(c: { query: Function }, merchantId: string, lock = false): Promise<PinRow> {
  const { rows } = await c.query(
    `SELECT phone_number, preferred_language, pin_hash, pin_failed_attempts, pin_locked_until FROM merchants WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [merchantId],
  );
  if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);
  return rows[0];
}

export async function hasPin(deps: Pick<Deps, 'db'>, merchantId: string): Promise<boolean> {
  return (await loadPinRow(deps.db, merchantId)).pin_hash !== null;
}

/**
 * Set a PIN. Called by Rails during onboarding, from an authenticated app session (not from USSD: a SIM swapper
 * could otherwise create the PIN that is meant to stop them). `reset` replaces an existing PIN (ops-verified
 * identity) and clears any lock. The trader gets a text either way.
 */
export async function setPin(deps: Deps, merchantId: string, pin: string, o: { reset?: boolean } = {}): Promise<void> {
  const row = await loadPinRow(deps.db, merchantId);
  assertAcceptable(pin, row.phone_number);
  if (row.pin_hash && !o.reset) throw new AppError('PIN_ALREADY_SET', 'This merchant already has a PIN. Use change or reset.', 409);
  const hash = await hashPin(pin, deps.config.pin.pepper);
  await withTx(deps.db, async (c) => {
    await c.query(
      `UPDATE merchants SET pin_hash = $2, pin_set_at = $3, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = now() WHERE id = $1`,
      [merchantId, hash, deps.clock()],
    );
    await enqueueSms(c, {
      merchantId,
      to: row.phone_number,
      kind: 'SECURITY',
      body: row.pin_hash ? pinChangedNotice(row.preferred_language) : pinSetNotice(row.preferred_language),
      at: deps.clock(),
    });
  });
}

/**
 * Check a PIN. Throws PIN_NOT_SET (422), PIN_LOCKED (423, details.locked_until) or PIN_INVALID (401,
 * details.attempts_remaining). Runs under a row lock so parallel guesses cannot beat the attempt counter.
 * Counter and lock are committed before the error is raised.
 */
export async function verifyPin(deps: Deps, merchantId: string, pin: string): Promise<void> {
  const cfg = deps.config.pin;
  const now = deps.clock();
  const outcome = await withTx(deps.db, async (c) => {
    const row = await loadPinRow(c, merchantId, true);
    if (!row.pin_hash) return { kind: 'NOT_SET' as const };
    if (row.pin_locked_until && row.pin_locked_until > now) return { kind: 'LOCKED' as const, until: row.pin_locked_until };
    if (/^\d{4}$/.test(pin) && (await matches(pin, row.pin_hash, cfg.pepper))) {
      if (row.pin_failed_attempts > 0 || row.pin_locked_until) {
        await c.query('UPDATE merchants SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1', [merchantId]);
      }
      return { kind: 'OK' as const };
    }
    const failed = row.pin_failed_attempts + 1;
    if (failed >= cfg.maxAttempts) {
      const until = new Date(now.getTime() + cfg.lockMinutes * 60_000);
      await c.query('UPDATE merchants SET pin_failed_attempts = 0, pin_locked_until = $2 WHERE id = $1', [merchantId, until]);
      await enqueueSms(c, {
        merchantId,
        to: row.phone_number,
        kind: 'SECURITY',
        body: pinLockedNotice(row.preferred_language, { minutes: cfg.lockMinutes }),
        at: now,
      });
      return { kind: 'LOCKED_NOW' as const, until };
    }
    await c.query('UPDATE merchants SET pin_failed_attempts = $2 WHERE id = $1', [merchantId, failed]);
    return { kind: 'WRONG' as const, remaining: cfg.maxAttempts - failed };
  });

  switch (outcome.kind) {
    case 'OK':
      return;
    case 'NOT_SET':
      throw new AppError('PIN_NOT_SET', 'Set a PIN in the Kobo Kobo app first.', 422);
    case 'LOCKED':
    case 'LOCKED_NOW':
      throw new AppError('PIN_LOCKED', 'Too many wrong PINs. Try again later.', 423, { locked_until: outcome.until.toISOString(), minutes: Math.ceil((outcome.until.getTime() - now.getTime()) / 60_000) });
    case 'WRONG':
      throw new AppError('PIN_INVALID', 'Wrong PIN.', 401, { attempts_remaining: outcome.remaining });
  }
}

/** Change a PIN: the old one must verify (and counts toward lockout). */
export async function changePin(deps: Deps, merchantId: string, oldPin: string, newPin: string): Promise<void> {
  await verifyPin(deps, merchantId, oldPin);
  if (oldPin === newPin) throw new AppError('PIN_UNCHANGED', 'The new PIN must be different from the old one.', 422);
  await setPin(deps, merchantId, newPin, { reset: true });
}
