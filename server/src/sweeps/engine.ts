import { randomUUID } from 'node:crypto';
import { addMessage } from '../messages/service';
import * as T from '../messages/templates';
import { recordContribution, nextPenReference } from '../arm/simulator';
import { BankError, type TestOutcome, type TransferResult } from '../bank/port';
import type { Deps } from '../deps';
import { tx, type Db } from '../db';
import type { GuardFlag, GuardInflow } from '../guard/port';
import { postGroup, reverseSweepGroups, settleSweepGroups } from '../ledger/ledger';
import { getMerchant, isPaused, type Merchant } from '../merchants/service';
import { koboToNaira, nairaDisplay, rateDisplay, toKobo, type Kobo } from '../money';
import { applyBuffer, computeSweepAmount, splitSweep } from '../split/engine';
import { sweepWindow } from '../time';

/**
 * The sweep state machine (PRD 6.3):
 *
 *   PLANNED -> HELD_GUARD | SKIPPED_* | SUBMITTED -> SETTLED | FAILED | UNKNOWN(requery) ;  SETTLED -> REVERSED
 *
 * Money-safety rules this file enforces:
 *  - One sweep per (merchant, date): a UNIQUE constraint, plus the same idempotency key and bank reference on every retry.
 *  - SUBMITTED is persisted BEFORE the bank is called, so a crash can never lose "this may have been sent".
 *  - On a timeout or a pending answer we NEVER send a new transfer. We requery the reference until it is final.
 *    A transfer is resent (same key, same reference) only when the bank confirms it has no record of it.
 *  - Ledger postings are idempotent and happen in the same transaction as the status change.
 */
export type SweepStatus =
  | 'PLANNED' | 'HELD_GUARD' | 'SKIPPED_ZERO_SALES' | 'SKIPPED_PAUSED' | 'SKIPPED_LOW_BALANCE'
  | 'SUBMITTED' | 'UNKNOWN' | 'SETTLED' | 'FAILED' | 'REVERSED';

export const TERMINAL: SweepStatus[] = ['HELD_GUARD', 'SKIPPED_ZERO_SALES', 'SKIPPED_PAUSED', 'SKIPPED_LOW_BALANCE', 'FAILED', 'REVERSED'];
const OPEN: SweepStatus[] = ['PLANNED', 'SUBMITTED', 'UNKNOWN'];
const MAX_SUBMITS = 6;
const CHECK_EVERY_MS = 30_000;

export interface Sweep {
  id: string;
  merchantId: string;
  sweepDate: string;
  windowStart: string;
  windowEnd: string;
  takings: Kobo;
  rateBps: number;
  sweep: Kobo;
  emergency: Kobo;
  retirement: Kobo;
  status: SweepStatus;
  idempotencyKey: string;
  bankReference: string;
  pensionReference: string | null;
  failureReason: string | null;
  lastError: string | null;
  attempts: number;
  nextCheckAt: string | null;
  watchUntil: string | null;
  settledAt: string | null;
}

export function mapSweep(r: any): Sweep {
  return {
    id: r.id, merchantId: r.merchant_id, sweepDate: r.sweep_date, windowStart: r.window_start, windowEnd: r.window_end,
    takings: toKobo(r.takings_kobo), rateBps: r.rate_bps, sweep: toKobo(r.sweep_kobo), emergency: toKobo(r.emergency_kobo),
    retirement: toKobo(r.retirement_kobo), status: r.status, idempotencyKey: r.idempotency_key, bankReference: r.bank_reference,
    pensionReference: r.pension_reference, failureReason: r.failure_reason, lastError: r.last_error, attempts: r.attempts,
    nextCheckAt: r.next_check_at, watchUntil: r.watch_until, settledAt: r.settled_at,
  };
}

export const getSweep = (db: Db, merchantId: string, date: string): Sweep | null => {
  const r = db.prepare('SELECT * FROM sweeps WHERE merchant_id = ? AND sweep_date = ?').get(merchantId, date);
  return r ? mapSweep(r) : null;
};
export const getSweepById = (db: Db, id: string): Sweep | null => {
  const r = db.prepare('SELECT * FROM sweeps WHERE id = ?').get(id);
  return r ? mapSweep(r) : null;
};
export const getSweepByReference = (db: Db, ref: string): Sweep | null => {
  const r = db.prepare('SELECT * FROM sweeps WHERE bank_reference = ?').get(ref);
  return r ? mapSweep(r) : null;
};

export const sweepKey = (merchantId: string, date: string) => `sweep:${merchantId}:${date}`;
/** Deterministic from (merchant, date) and never starts with "DUP-". */
export const sweepBankReference = (merchantId: string, date: string) => `SWP-${date.replaceAll('-', '')}-${merchantId.replaceAll('-', '').slice(0, 12)}`;

/**
 * Credits that count toward `date`'s sweep: counted, not held, and inside the rolling window. A credit that ops
 * dismissed from a hold counts from the moment of release (released_at), so it lands in the next window.
 */
export function windowInflows(db: Db, merchantId: string, date: string): { inflows: GuardInflow[]; total: Kobo } {
  const { from, to } = sweepWindow(date);
  const rows = db
    .prepare(
      `SELECT id, bank_reference, amount_kobo, settled_at FROM inflows
        WHERE merchant_id = ? AND counted = 1 AND (hold_status IS NULL OR hold_status = 'DISMISSED')
          AND COALESCE(released_at, settled_at) >= ? AND COALESCE(released_at, settled_at) < ?
        ORDER BY settled_at, id`,
    )
    .all(merchantId, from.toISOString(), to.toISOString()) as any[];
  const inflows = rows.map((r) => ({ id: r.id, bankReference: r.bank_reference, amount: toKobo(r.amount_kobo), settledAt: new Date(r.settled_at) }));
  return { inflows, total: inflows.reduce((s, i) => s + i.amount, 0n) };
}

const inFlight = new Set<string>();
const iso = (d: Date) => d.toISOString();
const later = (now: Date, ms: number) => iso(new Date(now.getTime() + ms));
const backoffMs = (n: number) => Math.min(15_000 * 2 ** Math.max(0, n - 1), 15 * 60_000);

interface RunOptions {
  /** Demo only: the x-test-outcome header for the first submission. */
  forceOutcome?: TestOutcome;
}

interface Planned {
  status: SweepStatus;
  takings: Kobo;
  rateBps: number;
  sweep?: Kobo;
  failureReason?: string;
  flags?: GuardFlag[];
  heldAmounts?: Map<string, Kobo>;
  sms?: { kind: string; body: string };
}

/** Insert the sweep row, apply guard holds and queue messages in ONE transaction. Returns null if a row already exists. */
function record(deps: Deps, m: Merchant, date: string, p: Planned): Sweep | null {
  const now = deps.clock();
  const { from, to } = sweepWindow(date);
  return tx(deps.db, () => {
    if (getSweep(deps.db, m.id, date)) return null; // checked before the PEN counter moves, so references stay gap-free
    const split = p.sweep && p.sweep > 0n ? splitSweep(p.sweep) : { emergency: 0n, retirement: 0n };
    const pen = p.status === 'PLANNED' ? nextPenReference(deps.db, date) : null;
    const r = deps.db
      .prepare(
        `INSERT INTO sweeps (id, merchant_id, sweep_date, window_start, window_end, takings_kobo, rate_bps, sweep_kobo, emergency_kobo, retirement_kobo,
                             status, idempotency_key, bank_reference, pension_reference, failure_reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (merchant_id, sweep_date) DO NOTHING RETURNING *`,
      )
      .get(
        randomUUID(), m.id, date, iso(from), iso(to), p.takings, p.rateBps, p.sweep ?? 0n, split.emergency, split.retirement, p.status,
        sweepKey(m.id, date), sweepBankReference(m.id, date), pen, p.failureReason ?? null, iso(now), iso(now),
      );
    if (!r) return null;
    const sweep = mapSweep(r);
    for (const f of p.flags ?? []) {
      const held = deps.db.prepare(`UPDATE inflows SET hold_status = 'HELD' WHERE id = ? AND hold_status IS NULL`).run(f.inflowId);
      if (held.changes === 0) continue;
      deps.db
        .prepare(`INSERT INTO guard_alerts (id, merchant_id, inflow_id, sweep_id, type, details, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(randomUUID(), m.id, f.inflowId, sweep.id, f.type, JSON.stringify(f.details), iso(now));
      const amt = p.heldAmounts?.get(f.inflowId);
      if (amt) addMessage(deps.db, { merchantId: m.id, kind: 'CREDIT_HELD', language: m.language, body: T.creditHeld(m.language, { amount: nairaDisplay(amt) }), dedupeKey: `held:${f.inflowId}`, at: now });
    }
    if (p.sms) addMessage(deps.db, { merchantId: m.id, kind: p.sms.kind, language: m.language, body: p.sms.body, dedupeKey: `${p.sms.kind.toLowerCase()}:${sweep.id}`, at: now });
    return sweep;
  });
}

/**
 * Decide tonight's sweep for one merchant, persist the decision, and (when there is money to move) carry it
 * through the bank. Safe to call any number of times: an existing row is advanced, never duplicated.
 * Throws if the bank balance cannot be read; nothing is recorded in that case, so the next run retries.
 */
export async function runSweepForMerchant(deps: Deps, merchantId: string, date: string, opts: RunOptions = {}): Promise<Sweep | null> {
  const existing = getSweep(deps.db, merchantId, date);
  if (existing) return TERMINAL.includes(existing.status) ? existing : advanceSweep(deps, existing.id, opts);

  const m = getMerchant(deps.db, merchantId);
  if (m.status !== 'ACTIVE') return null;
  const now = deps.clock();
  const { inflows, total } = windowInflows(deps.db, m.id, date);
  const base = { takings: total, rateBps: m.rateBps };

  const done = (p: Planned) => record(deps, m, date, p) ?? getSweep(deps.db, merchantId, date)!;
  if (isPaused(m, now)) return done({ ...base, status: 'SKIPPED_PAUSED' });
  if (total === 0n) return done({ ...base, status: 'SKIPPED_ZERO_SALES' });

  // SweepGuard: only the flagged credits are excluded; the rest of the day still sweeps.
  const flags = inflows.length ? await deps.guard.evaluate({ merchantId: m.id, sweepDate: date, inflows }) : [];
  const flagged = new Set(flags.map((f) => f.inflowId));
  const heldAmounts = new Map(inflows.filter((i) => flagged.has(i.id)).map((i) => [i.id, i.amount]));
  const takings = inflows.filter((i) => !flagged.has(i.id)).reduce((s, i) => s + i.amount, 0n);
  const common = { rateBps: m.rateBps, flags, heldAmounts };
  if (takings === 0n) return done({ ...common, takings: 0n, status: 'HELD_GUARD', failureReason: 'ALL_CREDITS_HELD' });

  const { sweep } = computeSweepAmount({ takings, rateHundredths: BigInt(m.rateBps), dailyCap: m.dailyCap });
  if (sweep === 0n) return done({ ...common, takings, status: 'SKIPPED_ZERO_SALES', failureReason: 'SWEEP_ROUNDS_TO_ZERO' });

  // May throw a BankError: nothing is recorded yet and the next run starts again (the guard is deterministic).
  const balance = await deps.bank.getBalance(m.bankAccount);
  const adjusted = applyBuffer({ sweep, balance, buffer: m.buffer });
  if (adjusted === 0n) {
    return done({
      ...common, takings, status: 'SKIPPED_LOW_BALANCE', failureReason: `BUFFER: balance ${koboToNaira(balance)}, buffer ${koboToNaira(m.buffer)}`,
      sms: { kind: 'SWEEP_SKIPPED', body: T.lowBalanceSkipped(m.language, { buffer: nairaDisplay(m.buffer) }) },
    });
  }
  const planned = done({ ...common, takings, status: 'PLANNED', sweep: adjusted });
  return TERMINAL.includes(planned.status) ? planned : advanceSweep(deps, planned.id, opts);
}

/** Move one open sweep forward one step. A sweep already being worked on in this process is left alone. */
export async function advanceSweep(deps: Deps, sweepId: string, opts: RunOptions = {}): Promise<Sweep> {
  const s = getSweepById(deps.db, sweepId);
  if (!s) throw new Error(`No such sweep ${sweepId}`);
  if (inFlight.has(sweepId)) return s;
  inFlight.add(sweepId);
  try {
    if (s.status === 'PLANNED') return await submit(deps, s, opts);
    if (s.status === 'SUBMITTED' || s.status === 'UNKNOWN') return await requery(deps, s, opts);
    if (s.status === 'SETTLED' && s.watchUntil && new Date(s.watchUntil) > deps.clock()) return await requery(deps, s, opts);
    return s;
  } finally {
    inFlight.delete(sweepId);
  }
}

function setStatus(db: Db, id: string, now: Date, status: SweepStatus, f: { reason?: string | null; error?: string | null; next?: string | null } = {}): Sweep {
  db.prepare(`UPDATE sweeps SET status = ?, failure_reason = COALESCE(?, failure_reason), last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?`).run(
    status, f.reason ?? null, f.error ?? null, f.next ?? null, iso(now), id,
  );
  return getSweepById(db, id)!;
}

async function submit(deps: Deps, s: Sweep, opts: RunOptions): Promise<Sweep> {
  const m = getMerchant(deps.db, s.merchantId);
  let now = deps.clock();
  // Persist SUBMITTED first: from here on the bank may hold a transfer for this reference.
  deps.db.prepare(`UPDATE sweeps SET status = 'SUBMITTED', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(iso(now), s.id);
  let stage: 'enquiry' | 'transfer' = 'enquiry';
  try {
    const ne = await deps.bank.nameEnquiry(deps.config.collectionAccount);
    stage = 'transfer';
    const res = await deps.bank.transfer({
      sourceAccount: m.bankAccount, destinationAccount: deps.config.collectionAccount, nameEnquiryRef: ne.nameEnquiryRef,
      amount: s.sweep, narration: `Kobo Kobo pension ${s.pensionReference}`, reference: s.bankReference, idempotencyKey: s.idempotencyKey,
      testOutcome: opts.forceOutcome,
    });
    return applyResult(deps, s.id, res);
  } catch (e) {
    if (!(e instanceof BankError)) throw e;
    now = deps.clock();
    const err = `${e.code}: ${e.message}`;
    // Outcome unknown at the transfer step: requery, never resend.
    if (stage === 'transfer' && e.unknownOutcome) return setStatus(deps.db, s.id, now, 'UNKNOWN', { error: err, next: later(now, CHECK_EVERY_MS) });
    // The request was not processed (or only the enquiry timed out): safe to try again later with the same key.
    if (e.notProcessed || (stage === 'enquiry' && e.unknownOutcome)) return setStatus(deps.db, s.id, now, 'SUBMITTED', { error: err, next: later(now, backoffMs(getSweepById(deps.db, s.id)!.attempts)) });
    return fail(deps, s.id, e.code, err);
  }
}

async function requery(deps: Deps, s: Sweep, opts: RunOptions): Promise<Sweep> {
  const now = deps.clock();
  let res: TransferResult | null;
  try {
    res = await deps.bank.getTransfer(s.bankReference);
  } catch (e) {
    if (!(e instanceof BankError)) throw e;
    deps.db.prepare(`UPDATE sweeps SET last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?`).run(`${e.code}: ${e.message}`, later(now, backoffMs(s.attempts)), iso(now), s.id);
    return getSweepById(deps.db, s.id)!;
  }
  if (res) return applyResult(deps, s.id, res);
  // The bank has no record of this reference: the earlier call never landed, so resending the SAME request is safe.
  if (s.status === 'SETTLED') return s;
  if (s.attempts >= MAX_SUBMITS) return fail(deps, s.id, 'RETRIES_EXHAUSTED', 'The bank never accepted the transfer');
  return submit(deps, s, opts);
}

/** Apply what the bank says about a transfer. Also the entry point for transfer.* webhooks. Idempotent. */
export function applyResult(deps: Deps, sweepId: string, res: TransferResult): Sweep {
  const s = getSweepById(deps.db, sweepId)!;
  const now = deps.clock();
  switch (res.status) {
    case 'successful':
      if (s.status === 'SETTLED' || s.status === 'REVERSED') return refreshWatch(deps, s);
      if (res.amount !== s.sweep) return fail(deps, s.id, 'AMOUNT_MISMATCH', `asked ${koboToNaira(s.sweep)}, bank moved ${koboToNaira(res.amount)} (ref ${res.reference})`);
      return settle(deps, s.id, res);
    case 'pending':
      if (s.status === 'SETTLED' || s.status === 'REVERSED') return s;
      return setStatus(deps.db, s.id, now, 'UNKNOWN', { next: later(now, CHECK_EVERY_MS) });
    case 'failed':
      if (s.status === 'SETTLED' || s.status === 'REVERSED') return s;
      return fail(deps, s.id, res.failureCode ?? 'TRANSFER_FAILED', res.failureCode ?? 'The bank failed the transfer');
    case 'reversed':
      if (s.status === 'SETTLED') return reverse(deps, s.id);
      if (s.status === 'REVERSED') return s;
      return fail(deps, s.id, 'REVERSED_BY_BANK', 'The bank reversed the transfer before we recorded it'); // nothing posted, nothing to undo
  }
}

function refreshWatch(deps: Deps, s: Sweep): Sweep {
  if (s.status === 'SETTLED') {
    const now = deps.clock();
    deps.db.prepare(`UPDATE sweeps SET next_check_at = ? WHERE id = ?`).run(later(now, 60_000), s.id);
  }
  return getSweepById(deps.db, s.id)!;
}

/** Post the ledger, mark SETTLED and queue the receipt: one transaction, idempotent. */
function settle(deps: Deps, sweepId: string, res: TransferResult): Sweep {
  const now = deps.clock();
  return tx(deps.db, () => {
    const s = getSweepById(deps.db, sweepId)!;
    if (s.status === 'SETTLED') return s;
    if (!OPEN.includes(s.status)) return s;
    const m = getMerchant(deps.db, s.merchantId);
    const split = { emergency: s.emergency, retirement: s.retirement };
    for (const g of settleSweepGroups({ sweepId: s.id, merchantId: s.merchantId, reference: s.pensionReference!, sweep: s.sweep, split, at: now })) postGroup(deps.db, g);
    recordContribution(deps.db, s.merchantId, now);
    deps.db
      .prepare(
        `UPDATE sweeps SET status = 'SETTLED', settled_at = ?, bank_fee_kobo = ?, bank_total_debit_kobo = ?, failure_reason = NULL, last_error = NULL,
                           watch_until = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(iso(now), res.fee + res.vat + res.stampDuty, res.totalDebit, later(now, deps.config.reversalWatchMinutes * 60_000), later(now, 60_000), iso(now), s.id);
    addMessage(deps.db, {
      merchantId: m.id, kind: 'SWEEP_RECEIPT', language: m.language, dedupeKey: `receipt:${s.id}`, at: now,
      body: T.sweepReceipt(m.language, {
        takings: nairaDisplay(s.takings), rate: rateDisplay(BigInt(s.rateBps)), sweep: nairaDisplay(s.sweep),
        emergency: nairaDisplay(s.emergency), retirement: nairaDisplay(s.retirement), reference: s.pensionReference!,
      }),
    });
    return getSweepById(deps.db, s.id)!;
  });
}

/** The bank reversed a settled sweep: post the exact contra entries, fix the vesting clock, tell the trader. */
function reverse(deps: Deps, sweepId: string): Sweep {
  const now = deps.clock();
  return tx(deps.db, () => {
    const s = getSweepById(deps.db, sweepId)!;
    if (s.status !== 'SETTLED') return s;
    const m = getMerchant(deps.db, s.merchantId);
    const split = { emergency: s.emergency, retirement: s.retirement };
    for (const g of reverseSweepGroups({ sweepId: s.id, merchantId: s.merchantId, reference: s.pensionReference!, sweep: s.sweep, split, at: now })) postGroup(deps.db, g);
    deps.db.prepare(`UPDATE sweeps SET status = 'REVERSED', failure_reason = 'REVERSED_BY_BANK', watch_until = NULL, next_check_at = NULL, updated_at = ? WHERE id = ?`).run(iso(now), s.id);
    // A reversed contribution must not keep the vesting clock running.
    deps.db
      .prepare(`UPDATE pension_accounts SET first_contribution_at = (SELECT MIN(settled_at) FROM sweeps WHERE merchant_id = ? AND status = 'SETTLED') WHERE merchant_id = ?`)
      .run(s.merchantId, s.merchantId);
    addMessage(deps.db, { merchantId: m.id, kind: 'SWEEP_REVERSED', language: m.language, dedupeKey: `reversed:${s.id}`, at: now, body: T.sweepReversed(m.language, { sweep: nairaDisplay(s.sweep), reference: s.pensionReference! }) });
    return getSweepById(deps.db, s.id)!;
  });
}

function fail(deps: Deps, sweepId: string, reason: string, detail: string): Sweep {
  const now = deps.clock();
  return tx(deps.db, () => {
    const s = getSweepById(deps.db, sweepId)!;
    if (!OPEN.includes(s.status)) return s;
    deps.db.prepare(`UPDATE sweeps SET status = 'FAILED', failure_reason = ?, last_error = ?, next_check_at = NULL, updated_at = ? WHERE id = ?`).run(reason, detail, iso(now), s.id);
    const m = getMerchant(deps.db, s.merchantId);
    if (reason !== 'AMOUNT_MISMATCH') addMessage(deps.db, { merchantId: m.id, kind: 'SWEEP_FAILED', language: m.language, dedupeKey: `failed:${s.id}`, at: now, body: T.sweepFailed(m.language) });
    return getSweepById(deps.db, s.id)!;
  });
}

/** The requery loop: look again at every open sweep (and recently settled ones, for late reversals) that is due. */
export async function requeryDue(deps: Deps): Promise<number> {
  const now = iso(deps.clock());
  const rows = deps.db
    .prepare(
      `SELECT id FROM sweeps
        WHERE (status IN ('PLANNED','SUBMITTED','UNKNOWN') AND (next_check_at IS NULL OR next_check_at <= ?))
           OR (status = 'SETTLED' AND watch_until > ? AND (next_check_at IS NULL OR next_check_at <= ?))
        ORDER BY updated_at LIMIT 50`,
    )
    .all(now, now, now) as { id: string }[];
  for (const r of rows) {
    try {
      await advanceSweep(deps, r.id);
    } catch (e) {
      console.error(`[requery] sweep ${r.id}:`, (e as Error).message);
    }
  }
  return rows.length;
}
