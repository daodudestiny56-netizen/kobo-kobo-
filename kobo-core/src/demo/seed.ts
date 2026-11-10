import type { AppConfig } from '../config';
import type { Pool } from '../db/pool';
import type { Deps } from '../deps';
import { MockExecutor } from '../executors/mock';
import { AllowAllGuard } from '../guard';
import { hashPin } from '../security/pin';
import { issueRsaPin } from '../pfa/simulator';
import { ConsoleSmsProvider } from '../sms/provider';
import { createSuggestion } from '../smart-rate/service';
import { executeSweepForMerchant } from '../sweeps/service';
import { addDays, sweepCutoff, sweepWindow, toWatDate } from '../time';
import { requestEmergencyWithdrawal } from '../withdrawals/service';
import { ConsoleVoiceProvider } from '../voice/provider';

/**
 * Demo data: a handful of traders whose history is built by running the REAL sweep engine day by day on a simulated clock,
 * so pots, ledger, PEN references and receipts are all genuine and reconciliation is clean. Tonight's takings are
 * inserted but NOT swept: that is what you run live (`npm run demo:sweep`).
 */
export interface Persona {
  key: string;
  name: string;
  phone: string;
  language: 'en' | 'pidgin';
  pin: string;
  rate: string;
  /** Days of sweep history to build before today. */
  historyDays: number;
  /** Typical daily takings in naira (varied +-30% deterministically). */
  dailyTakings: number;
  /** Tonight's takings in naira, inserted unswept. */
  tonight: number[];
  buffer?: string;
  paused?: boolean;
  /** Withdraw this many naira this many days ago (starts the cooldown). */
  pastWithdrawal?: { daysAgo: number; naira: number };
  suggestRate?: string;
  story: string;
}

export const PERSONAS: Persona[] = [
  { key: 'ngozi', name: 'Mama Ngozi', phone: '+2348031230001', language: 'pidgin', pin: '7391', rate: '2.00', historyDays: 125, dailyTakings: 38000, tonight: [12000, 18500, 14500], story: 'Vested (4+ months). Can withdraw. Pidgin. Normal sweep tonight.' },
  { key: 'musa', name: 'Alhaji Musa', phone: '+2348031230002', language: 'en', pin: '2846', rate: '3.00', historyDays: 110, dailyTakings: 90000, tonight: [60000, 45000, 15000], suggestRate: '4', story: 'Vested. English. Has a pending Smart Rate suggestion (reply YES / NO).' },
  { key: 'chidi', name: 'Chidi Okeke', phone: '+2348031230003', language: 'en', pin: '5937', rate: '2.00', historyDays: 30, dailyTakings: 24000, tonight: [9000, 11000], story: 'Young account (1 month): the Emergency Pot is still closed.' },
  { key: 'funmi', name: 'Funmi Adebayo', phone: '+2348031230004', language: 'en', pin: '4682', rate: '2.00', historyDays: 120, dailyTakings: 30000, tonight: [8000, 9500], pastWithdrawal: { daysAgo: 20, naira: 500 }, story: 'Vested but withdrew 20 days ago: 60-day cooldown is active.' },
  { key: 'bisi', name: 'Bisi Lawal', phone: '+2348031230005', language: 'pidgin', pin: '8153', rate: '2.00', historyDays: 60, dailyTakings: 27000, tonight: [20000, 7000], paused: true, story: 'Paused for 48 hours: tonight is skipped.' },
  { key: 'emeka', name: 'Emeka Nwosu', phone: '+2348031230006', language: 'en', pin: '9274', rate: '2.00', historyDays: 45, dailyTakings: 21000, tonight: [15000, 6000], buffer: '5000000.00', story: 'Account balance is below the minimum buffer: tonight is skipped.' },
  { key: 'ife', name: 'Ife Balogun', phone: '+2348031230007', language: 'en', pin: '6410', rate: '2.00', historyDays: 90, dailyTakings: 33000, tonight: [1_800_000, 900_000], story: 'A very large night. With GUARD_HOLD_ABOVE_NAIRA set, Sweep Guard holds it; text OK to release.' },
];

const DEMO_BALANCE = 10_000_000_000n; // N100m in kobo: history sweeps never run short

/** Small deterministic PRNG so every seed run builds identical history. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

async function resetAll(db: Pool): Promise<void> {
  await db.query(
    `TRUNCATE sms_outbox, voice_callback_requests, rate_suggestions, sweep_guard_alerts, emergency_withdrawals, ledger_entries,
              daily_sweeps, pension_references, pen_reference_counters, inflow_transactions, pension_accounts, merchants
     RESTART IDENTITY CASCADE`,
  );
}

export interface SeedResult {
  today: string;
  personas: (Persona & { merchantId: string; nuban: string })[];
}

/** Reset and seed. `now` is injectable for tests. Never touches the bank: history uses a private mock executor. */
export async function seedDemo(db: Pool, config: AppConfig, now: Date = new Date()): Promise<SeedResult> {
  const today = toWatDate(now);
  let clock = now;
  const deps: Deps = {
    db,
    config,
    clock: () => clock,
    executor: new MockExecutor(DEMO_BALANCE),
    guard: new AllowAllGuard(),
    sms: new ConsoleSmsProvider(),
    voice: new ConsoleVoiceProvider(),
  };
  await resetAll(db);

  const out: SeedResult['personas'] = [];
  let n = 0;
  for (const p of PERSONAS) {
    n++;
    const nuban = String(2000000000 + n * 1111);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO merchants (phone_number, full_name, bvn_hash, access_nuban, preferred_language, sweep_percentage, min_buffer_balance, pin_hash, pin_set_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [p.phone, p.name, `demo-bvn-${p.key}`, nuban, p.language, p.rate, p.buffer ?? '1000.00', await hashPin(p.pin, config.pin.pepper), addDays(today, -p.historyDays - 1)],
    );
    const id = ins.rows[0].id;
    await issueRsaPin(db, id);
    out.push({ ...p, merchantId: id, nuban });

    // History: for each past day, add that day's takings, then run the real sweep after the 23:00 cut-off.
    const rand = rng(n * 7919);
    for (let d = p.historyDays; d >= 1; d--) {
      const date = addDays(today, -d);
      const cutoff = sweepCutoff(date);
      const pieces = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < pieces; k++) {
        const amount = Math.max(500, Math.round((p.dailyTakings / pieces) * (0.7 + rand() * 0.6) / 50) * 50);
        const at = new Date(cutoff.getTime() - (2 + Math.floor(rand() * 600)) * 60_000);
        await db.query(
          `INSERT INTO inflow_transactions (merchant_id, bank_reference, amount, channel, settled_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)`,
          [id, `DEMO-${p.key}-${date}-${k}`, amount.toFixed(2), ['POS', 'NIP_TRANSFER', 'QR'][k % 3], at],
        );
      }
      clock = new Date(cutoff.getTime() + 10 * 60_000);
      await executeSweepForMerchant(deps, id, date);
      if (p.pastWithdrawal && d === p.pastWithdrawal.daysAgo) {
        await requestEmergencyWithdrawal(deps, { merchantId: id, amount: BigInt(p.pastWithdrawal.naira) * 100n });
      }
    }
  }

  // Everything above was history: mark its texts as delivered so the live dispatcher never sends them.
  await db.query(`UPDATE sms_outbox SET status = 'SENT', provider_message_id = 'demo-history', sent_at = created_at WHERE status <> 'SENT'`);

  // Tonight: takings inside today's window, relative to the real clock. Not swept yet.
  clock = now;
  const windowStart = sweepWindow(today).from;
  const latest = new Date(Math.min(now.getTime(), sweepCutoff(today).getTime() - 10 * 60_000));
  for (const p of out) {
    for (let k = 0; k < p.tonight.length; k++) {
      const at = new Date(Math.max(windowStart.getTime() + 60_000, latest.getTime() - (k * 7 + 3) * 60_000));
      await db.query(
        `INSERT INTO inflow_transactions (merchant_id, bank_reference, amount, channel, settled_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)`,
        [p.merchantId, `DEMO-${p.key}-tonight-${k}`, p.tonight[k].toFixed(2), ['POS', 'NIP_TRANSFER', 'QR'][k % 3], at],
      );
    }
    if (p.paused) await db.query(`UPDATE merchants SET is_paused = true, paused_until = $2 WHERE id = $1`, [p.merchantId, new Date(now.getTime() + 48 * 3_600_000)]);
    if (p.suggestRate) await createSuggestion(deps, { merchantId: p.merchantId, suggestedRate: BigInt(Math.round(Number(p.suggestRate) * 100)), reason: 'Demo: steady takings for 8 weeks' });
  }
  return { today, personas: out };
}
