import { tx, type Db } from '../db';
import { SimulatedBank } from '../bank/simulated';
import { AllowAllGuard } from '../guard/port';
import type { Deps } from '../deps';
import { onboardMerchant, type Language } from '../merchants/service';
import { addMessage } from '../messages/service';
import { runSweepForMerchant } from '../sweeps/engine';
import { createSuggestion } from '../smart-rate/service';
import { addDays, sweepCutoff, sweepWindow, toWatDate } from '../time';
import { requestWithdrawal } from '../withdrawals/service';
import { pauseMerchant } from '../merchants/service';
import { recordInflow } from '../inflows/service';
import { DEMO_TRADERS } from './traders';

/**
 * Demo data (synthetic only). Each trader's history is built by running the REAL sweep engine day by day on a
 * private simulated bank and a stepped clock, so pots, ledger, PEN references and receipts are genuine and
 * reconciliation is clean. Tonight's takings are recorded but NOT swept: that is what you run live.
 */
export interface Persona {
  key: string; name: string; phone: string; language: Language; rateBps: number;
  historyDays: number; dailyTakings: number; tonight: number[];
  /** Set for the four sandbox individuals: their real sandbox account and BVN. Others exist only on the simulated bank. */
  sandbox?: { bankAccount: string; bvn: string };
  bufferNaira?: number; paused?: boolean; pastWithdrawal?: { daysAgo: number; naira: number }; suggestBps?: number; story: string;
}

const fx = (i: number) => DEMO_TRADERS[i];
const sandbox = (i: number) => ({ name: fx(i).fullName, phone: fx(i).phone, language: fx(i).language, sandbox: { bankAccount: fx(i).bankAccount, bvn: fx(i).bvn } });

export const PERSONAS: Persona[] = [
  { key: 'adaeze', ...sandbox(0), rateBps: 200, historyDays: 128, dailyTakings: 30000, tonight: [12000, 18500, 14500], pastWithdrawal: { daysAgo: 71, naira: 3000 }, story: 'Vested (4+ months), last withdrew 71 days ago: can withdraw now. Pidgin.' },
  { key: 'babatunde', ...sandbox(1), rateBps: 300, historyDays: 96, dailyTakings: 24000, tonight: [9000, 14000], suggestBps: 400, story: 'Vested. Has a Smart Rate suggestion waiting (reply YES or NO).' },
  { key: 'musa', ...sandbox(2), rateBps: 200, historyDays: 58, dailyTakings: 11500, tonight: [5000, 6500], story: 'Eight weeks in: the Emergency Pot is still closed.' },
  { key: 'efosa', ...sandbox(3), rateBps: 200, historyDays: 26, dailyTakings: 9000, tonight: [4000, 3500], story: 'New account (under a month): the Emergency Pot is closed.' },
  { key: 'funmi', name: 'Funmi Adebayo', phone: '+2348031230004', language: 'en', rateBps: 200, historyDays: 120, dailyTakings: 30000, tonight: [8000, 9500], pastWithdrawal: { daysAgo: 20, naira: 500 }, story: 'Vested but withdrew 20 days ago: the 2-month cooldown is active. (simulated bank only)' },
  { key: 'bisi', name: 'Bisi Lawal', phone: '+2348031230005', language: 'pidgin', rateBps: 200, historyDays: 60, dailyTakings: 27000, tonight: [20000, 7000], paused: true, story: 'Paused for 48 hours: tonight is skipped. (simulated bank only)' },
  { key: 'emeka', name: 'Emeka Nwosu', phone: '+2348031230006', language: 'en', rateBps: 200, historyDays: 45, dailyTakings: 21000, tonight: [15000, 6000], bufferNaira: 5_000_000, story: 'Balance below the minimum buffer: tonight is skipped. (simulated bank only)' },
  { key: 'ife', name: 'Ife Balogun', phone: '+2348031230007', language: 'en', rateBps: 200, historyDays: 90, dailyTakings: 33000, tonight: [1_800_000, 900_000], story: 'A very large night. With GUARD_HOLD_ABOVE_NAIRA=1000000 the guard holds the big credit; the smaller one still sweeps. (simulated bank only)' },
];

/** Deterministic PRNG so every seed builds identical history. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Delete every business row. Ledger triggers forbid DELETE, so they are dropped and recreated in the same transaction. */
export function resetAll(db: Db): void {
  tx(db, () => {
    const triggers = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ledger_entries'`).all() as { name: string; sql: string }[];
    for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
    for (const table of ['messages', 'rate_suggestions', 'guard_alerts', 'ledger_entries', 'withdrawals', 'sweeps', 'inflows', 'pension_accounts', 'consents', 'merchants', 'webhook_events', 'pen_counters', 'demo_state']) {
      db.exec(`DELETE FROM ${table}`);
    }
    for (const t of triggers) db.exec(t.sql);
  });
}

export interface SeedResult {
  today: string;
  personas: (Persona & { merchantId: string; bankAccount: string })[];
}

const CHANNELS = ['POS', 'NIP_TRANSFER', 'QR'];
const ACCOUNT_BASE = 2_000_000_000;

/** Reset and seed. `deps.bank` is only touched to give the live simulated bank balances; history uses a private bank. */
export async function seedDemo(deps: Deps, now: Date = deps.clock()): Promise<SeedResult> {
  const { db, config } = deps;
  const today = toWatDate(now);
  resetAll(db);

  let clock = now;
  const hist: Deps = { db, config, clock: () => clock, bank: new SimulatedBank(() => clock), guard: new AllowAllGuard() };
  const out: SeedResult['personas'] = [];

  // A real bank only knows the four sandbox individuals; the other personas need the simulated bank.
  const realBank = !(deps.bank instanceof SimulatedBank);
  const left = new Set(config.demoUnenrolledAccounts);
  const personas = PERSONAS.filter((p) => (p.sandbox || !realBank) && !(p.sandbox && left.has(p.sandbox.bankAccount)));
  let n = 0;
  for (const p of personas) {
    n++;
    const bankAccount = p.sandbox?.bankAccount ?? config.demoBankAccounts[n - 1] ?? String(ACCOUNT_BASE + n * 1111).padStart(10, '0');
    (hist.bank as SimulatedBank).setBalance(bankAccount, 100_000_000_00n, p.name);
    const { merchant } = onboardMerchant(db, {
      phone: p.phone, fullName: p.name, bvn: p.sandbox?.bvn ?? `2230000${String(n).padStart(4, '0')}`, bankAccount, language: p.language, rateBps: p.rateBps,
      buffer: p.bufferNaira ? BigInt(p.bufferNaira) * 100n : undefined, at: new Date(sweepCutoff(addDays(today, -p.historyDays - 1)).getTime()),
    });
    out.push({ ...p, merchantId: merchant.id, bankAccount });

    const rand = rng(n * 7919);
    for (let d = p.historyDays; d >= 1; d--) {
      const date = addDays(today, -d);
      const cutoff = sweepCutoff(date);
      const pieces = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < pieces; k++) {
        // Whole multiples of N50 keep every sweep amount clear of the sandbox trigger digits.
        const naira = Math.max(500, Math.round(((p.dailyTakings / pieces) * (0.7 + rand() * 0.6)) / 50) * 50);
        const at = new Date(cutoff.getTime() - (2 + Math.floor(rand() * 600)) * 60_000);
        recordInflow(hist, { merchantId: merchant.id, amount: BigInt(naira) * 100n, channel: CHANNELS[k % 3], bankReference: `DEMO-${p.key}-${date}-${k}`, settledAt: at });
      }
      clock = new Date(cutoff.getTime() + 10 * 60_000);
      await runSweepForMerchant(hist, merchant.id, date);
      if (p.pastWithdrawal && d === p.pastWithdrawal.daysAgo) await requestWithdrawal(hist, merchant.id, BigInt(p.pastWithdrawal.naira) * 100n);
    }
  }

  db.exec('DELETE FROM messages'); // history texts would flood the simulators

  // Tonight: takings inside today's window, relative to the real clock, not swept yet.
  clock = now;
  const windowStart = sweepWindow(today).from;
  const latest = new Date(Math.min(now.getTime(), sweepCutoff(today).getTime() - 10 * 60_000));
  for (const p of out) {
    p.tonight.forEach((naira, k) => {
      const at = new Date(Math.max(windowStart.getTime() + 60_000, latest.getTime() - (k * 7 + 3) * 60_000));
      recordInflow(hist, { merchantId: p.merchantId, amount: BigInt(naira) * 100n, channel: CHANNELS[k % 3], bankReference: `DEMO-${p.key}-tonight-${k}`, settledAt: at });
    });
    if (p.paused) pauseMerchant(db, p.merchantId, now, 48);
    if (p.suggestBps) createSuggestion(hist, { merchantId: p.merchantId, suggestedBps: p.suggestBps, reason: 'Demo: steady takings for 8 weeks' });
    addMessage(db, { merchantId: p.merchantId, kind: 'WELCOME', language: p.language, at: now, body: p.language === 'pidgin' ? 'Welcome to Kobo Kobo. Text HELP to see wetin you fit do.' : 'Welcome to Kobo Kobo. Text HELP to see what you can do.' });
  }

  // The live (simulated) bank needs the demo accounts too, with balances that make the stories play out:
  // everyone can be swept except Emeka, whose balance is under his buffer.
  const live = deps.bank;
  if (live instanceof SimulatedBank) {
    for (const p of out) live.setBalance(p.bankAccount, p.key === 'emeka' ? 3_000_000_00n : 20_000_000_00n, p.name);
  }
  return { today, personas: out };
}
