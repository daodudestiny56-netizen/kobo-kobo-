import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { tx } from '../db';
import { AppError } from '../errors';
import { toKobo, type Kobo } from '../money';
import { createPensionAccount } from '../arm/simulator';
import { NEVER } from '../time';

export type Language = 'en' | 'pidgin' | 'yoruba' | 'hausa' | 'igbo';
export const LANGUAGES: Language[] = ['en', 'pidgin', 'yoruba', 'hausa', 'igbo'];

export interface Merchant {
  id: string;
  phone: string;
  fullName: string;
  bankAccount: string;
  virtualAccount: string | null;
  language: Language;
  rateBps: number;
  dailyCap: Kobo;
  buffer: Kobo;
  pausedUntil: Date | null;
  status: 'ACTIVE' | 'CANCELLED';
  createdAt: Date;
}

const COLS = 'id, phone, full_name, bank_account, virtual_account, language, rate_bps, daily_cap_kobo, buffer_kobo, paused_until, status, created_at';

function map(r: any): Merchant {
  return {
    id: r.id, phone: r.phone, fullName: r.full_name, bankAccount: r.bank_account, virtualAccount: r.virtual_account,
    language: r.language, rateBps: r.rate_bps, dailyCap: toKobo(r.daily_cap_kobo), buffer: toKobo(r.buffer_kobo),
    pausedUntil: r.paused_until ? new Date(r.paused_until) : null, status: r.status, createdAt: new Date(r.created_at),
  };
}

export const hashBvn = (bvn: string) => createHash('sha256').update(`kobo:${bvn}`).digest('hex');

export function getMerchant(db: Db, id: string): Merchant {
  const r = db.prepare(`SELECT ${COLS} FROM merchants WHERE id = ?`).get(id);
  if (!r) throw new AppError('MERCHANT_NOT_FOUND', 'No such merchant.', 404);
  return map(r);
}

export function findMerchantByPhone(db: Db, phone: string): Merchant | null {
  const r = db.prepare(`SELECT ${COLS} FROM merchants WHERE phone = ?`).get(phone);
  return r ? map(r) : null;
}

export function listActiveMerchants(db: Db): Merchant[] {
  return (db.prepare(`SELECT ${COLS} FROM merchants WHERE status = 'ACTIVE' ORDER BY created_at, id`).all() as any[]).map(map);
}

export function isPaused(m: Merchant, now: Date): boolean {
  return m.pausedUntil !== null && m.pausedUntil.getTime() > now.getTime();
}

export const CONSENT_TEXT_VERSION = 'consent-v1';

/**
 * Create a trader after the bank checks have passed (identity, name match: the bank client owns those). Records the
 * consent, issues the simulated RSA PIN and returns the new merchant. One active plan per BVN (UNIQUE bvn_hash).
 */
export function onboardMerchant(
  db: Db,
  a: {
    phone: string; fullName: string; bvn: string; bankAccount: string; virtualAccount?: string | null;
    language?: Language; rateBps?: number; dailyCap?: Kobo; buffer?: Kobo; consentVersion?: string; at: Date;
  },
): { merchant: Merchant; rsaPin: string } {
  const rate = a.rateBps ?? 200;
  assertRate(rate);
  const id = randomUUID();
  try {
    return tx(db, () => {
      db.prepare(
        `INSERT INTO merchants (id, phone, full_name, bvn_hash, bank_account, virtual_account, language, rate_bps, daily_cap_kobo, buffer_kobo, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, a.phone, a.fullName, hashBvn(a.bvn), a.bankAccount, a.virtualAccount ?? null, a.language ?? 'pidgin', rate, a.dailyCap ?? 500_000n, a.buffer ?? 100_000n, a.at.toISOString());
      db.prepare(`INSERT INTO consents (id, merchant_id, text_version, given_at) VALUES (?,?,?,?)`).run(randomUUID(), id, a.consentVersion ?? CONSENT_TEXT_VERSION, a.at.toISOString());
      const pa = createPensionAccount(db, id, a.at);
      return { merchant: getMerchant(db, id), rsaPin: pa.rsaPin };
    });
  } catch (e) {
    const m = (e as Error).message;
    if (/UNIQUE constraint failed: merchants\.(bvn_hash)/.test(m)) throw new AppError('ALREADY_ENROLLED', 'This person already has an active plan.', 409);
    if (/UNIQUE constraint failed: merchants\.(phone|bank_account)/.test(m)) throw new AppError('ALREADY_ENROLLED', 'This phone or account is already enrolled.', 409);
    throw e;
  }
}

export function assertRate(bps: number): void {
  if (!Number.isInteger(bps) || bps < 100 || bps > 500) throw new AppError('INVALID_RATE', 'Rate must be between 1% and 5%.', 400);
}

export function setRateBps(db: Db, id: string, bps: number): Merchant {
  assertRate(bps);
  db.prepare(`UPDATE merchants SET rate_bps = ? WHERE id = ? AND status = 'ACTIVE'`).run(bps, id);
  return getMerchant(db, id);
}

/** Pause for `hours`, or until resumed when omitted. */
export function pauseMerchant(db: Db, id: string, now: Date, hours?: number): Merchant {
  const until = hours === undefined ? NEVER : new Date(now.getTime() + hours * 3_600_000).toISOString();
  db.prepare(`UPDATE merchants SET paused_until = ? WHERE id = ? AND status = 'ACTIVE'`).run(until, id);
  return getMerchant(db, id);
}

export function resumeMerchant(db: Db, id: string): Merchant {
  db.prepare(`UPDATE merchants SET paused_until = NULL WHERE id = ?`).run(id);
  return getMerchant(db, id);
}

/** Cancel: sweeps stop at once and the consent is withdrawn. The pension balance stays in the trader's pension. */
export function cancelMerchant(db: Db, id: string, now: Date): Merchant {
  tx(db, () => {
    db.prepare(`UPDATE merchants SET status = 'CANCELLED' WHERE id = ?`).run(id);
    db.prepare(`UPDATE consents SET withdrawn_at = ? WHERE merchant_id = ? AND withdrawn_at IS NULL`).run(now.toISOString(), id);
  });
  return getMerchant(db, id);
}
