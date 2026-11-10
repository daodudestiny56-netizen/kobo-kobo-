import { loadConfig } from '../src/config';
import type { Deps } from '../src/deps';
import { MockExecutor } from '../src/executors/mock';
import { AllowAllGuard } from '../src/guard';
import { ConsoleSmsProvider } from '../src/sms/provider';
import { ConsoleVoiceProvider } from '../src/voice/provider';
import { hashPin } from '../src/security/pin';
import { createPool, type Pool } from '../src/db/pool';
import { koboToNaira, type Kobo } from '../src/money';

/** Night of 2026-11-06: 23:30 WAT, i.e. after the 23:00 cut-off, so that day's window is closed. */
export const NIGHT = new Date('2026-11-06T22:30:00Z');
export const DAY = '2026-11-06';
/** An instant inside DAY's sweep window (15:00 WAT on the 6th). */
export const DURING = new Date('2026-11-06T14:00:00Z');

/** Deps with a controllable clock, a MockExecutor, an allow-all guard and zero backoff so retries are instant. */
export function makeDeps(
  pool: Pool,
  o: { now?: Date; config?: Partial<ReturnType<typeof loadConfig>>; sweep?: Partial<ReturnType<typeof loadConfig>['sweep']> } = {},
): Deps & { executor: MockExecutor; sms: ConsoleSmsProvider; voice: ConsoleVoiceProvider; setNow(d: Date): void } {
  let now = o.now ?? NIGHT;
  const base = loadConfig({ LOG_LEVEL: 'silent' });
  return {
    db: pool,
    config: { ...base, ...o.config, sweep: { ...base.sweep, backoffBaseMs: 0, ...o.sweep } },
    clock: () => now,
    executor: new MockExecutor(),
    guard: new AllowAllGuard(),
    sms: new ConsoleSmsProvider(),
    voice: new ConsoleVoiceProvider(),
    setNow: (d: Date) => {
      now = d;
    },
  };
}

export function testPool(): Pool {
  return createPool(process.env.DATABASE_URL!);
}

/** Empty every table. TRUNCATE does not fire the ledger's row-level immutability trigger. */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE sms_outbox, voice_callback_requests, rate_suggestions, sweep_guard_alerts, emergency_withdrawals, ledger_entries,
              daily_sweeps, pension_references, pen_reference_counters, inflow_transactions, pension_accounts, merchants
     RESTART IDENTITY CASCADE`,
  );
}

let seq = 0;
const next = () => ++seq;

export interface MerchantOpts {
  phone?: string;
  name?: string;
  rate?: string;
  cap?: string;
  buffer?: string;
  language?: string;
  paused?: boolean;
  pausedUntil?: Date | null;
  /** Set a PIN (hashed with the test config's empty pepper). */
  pin?: string;
}

export async function makeMerchant(pool: Pool, o: MerchantOpts = {}) {
  const n = next();
  const phone = o.phone ?? `+23480${String(30000000 + n).padStart(8, '0')}`;
  const nuban = String(1000000000 + n);
  const { rows } = await pool.query(
    `INSERT INTO merchants (phone_number, full_name, bvn_hash, access_nuban, preferred_language, sweep_percentage,
                            daily_cap, min_buffer_balance, is_paused, paused_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, phone_number, access_nuban`,
    [
      phone,
      o.name ?? `Trader ${n}`,
      `bvnhash${n}`,
      nuban,
      o.language ?? 'en',
      o.rate ?? '2.00',
      o.cap ?? '5000.00',
      o.buffer ?? '1000.00',
      o.paused ?? false,
      o.pausedUntil ?? null,
    ],
  );
  if (o.pin) await pool.query('UPDATE merchants SET pin_hash = $2, pin_set_at = now() WHERE id = $1', [rows[0].id, await hashPin(o.pin, '')]);
  return rows[0] as { id: string; phone_number: string; access_nuban: string };
}

export async function makePensionAccount(
  pool: Pool,
  merchantId: string,
  o: { emergency?: string; retirement?: string; firstContributionAt?: Date | null; lastWithdrawalAt?: Date | null } = {},
) {
  const n = next();
  await pool.query(
    `INSERT INTO pension_accounts (merchant_id, rsa_pin, emergency_balance, retirement_balance, first_contribution_at, last_withdrawal_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [merchantId, `PEN${String(100000000000 + n)}`, o.emergency ?? '0.00', o.retirement ?? '0.00', o.firstContributionAt ?? null, o.lastWithdrawalAt ?? null],
  );
}

/** A fully onboarded trader: merchant row + RSA. */
export async function makeTrader(pool: Pool, o: MerchantOpts & { pension?: Parameters<typeof makePensionAccount>[2] } = {}) {
  const m = await makeMerchant(pool, o);
  await makePensionAccount(pool, m.id, o.pension);
  return m;
}

export async function addInflow(
  pool: Pool,
  merchantId: string,
  amount: Kobo | string,
  settledAt: Date,
  o: { excluded?: boolean; channel?: string; reference?: string } = {},
) {
  const n = next();
  await pool.query(
    `INSERT INTO inflow_transactions (merchant_id, bank_reference, amount, channel, is_excluded_from_sweep, exclusion_reason, settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      merchantId,
      o.reference ?? `REF-${n}`,
      typeof amount === 'bigint' ? koboToNaira(amount) : amount,
      o.channel ?? 'POS',
      o.excluded ?? false,
      o.excluded ? 'LOAN_DISBURSEMENT' : null,
      settledAt,
    ],
  );
}
