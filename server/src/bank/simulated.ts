import { BankError, type BankPort, type NameEnquiry, type TestOutcome, type TransferRequest, type TransferResult } from './port';
import type { Kobo } from '../money';

/**
 * In-memory stand-in for the Xtradot sandbox's intra-bank transfers, with the same trigger values (guide 5.5):
 *   amount ending .01 -> INSUFFICIENT_FUNDS      .02 -> TIMEOUT, then failed and reversed after 30 s
 *   amount ending .03 -> pending 2 min, then successful      .04 -> successful, then reversed after about 60 s
 *   reference starting DUP- -> DUPLICATE_REQUEST   account 0000000001 -> ACCOUNT_NOT_FOUND   0000000002 -> TIMEOUT
 * Used for local development and tests until the real client lands, and kept for demo mode. Time comes from an
 * injected clock so the 30 s / 60 s / 2 min transitions are deterministic.
 */
interface Rec {
  req: TransferRequest;
  bodyKey: string;
  plan: 'ok' | 'failed' | 'pending_then_ok' | 'ok_then_reversed' | 'timeout_then_failed' | 'timeout_then_ok';
  createdAt: number;
  moved: boolean;
  reversed: boolean;
}

const SEED: Record<string, { name: string; balance: Kobo }> = {
  '0123456789': { name: 'Adaeze Chiamaka Okonkwo', balance: 1_500_000_00n },
  '0123456790': { name: 'Babatunde Olumide Adeyemi', balance: 5_000_000_00n },
  '0123456791': { name: 'Musa Ibrahim Abdullahi', balance: 250_000_00n },
  '0123456792': { name: 'Efosa Godwin Osagie', balance: 40_000_00n },
  '0123456793': { name: 'Mama Nkechi Provisions Ltd', balance: 12_000_000_00n },
};

export class SimulatedBank implements BankPort {
  readonly accounts = new Map<string, { name: string; balance: Kobo }>();
  private enquiries = new Map<string, { dest: string; at: number; used: boolean }>();
  private byKey = new Map<string, Rec>();
  private byRef = new Map<string, Rec>();
  private n = 0;
  /** Calls seen, so tests can assert "exactly one transfer". */
  readonly calls = { balance: 0, nameEnquiry: 0, transfer: 0, getTransfer: 0 };
  /** Fail the next N calls of an operation with a given error (for tests). */
  private failures: { op: keyof SimulatedBank['calls']; code: BankError['code'] }[] = [];

  constructor(private readonly now: () => Date = () => new Date(), seed: typeof SEED = SEED) {
    for (const [k, v] of Object.entries(seed)) this.accounts.set(k, { ...v });
  }

  fail(op: keyof SimulatedBank['calls'], code: BankError['code']): this {
    this.failures.push({ op, code });
    return this;
  }
  private takeFailure(op: keyof SimulatedBank['calls']) {
    const i = this.failures.findIndex((f) => f.op === op);
    if (i >= 0) throw new BankError(this.failures.splice(i, 1)[0].code, `simulated ${op} failure`);
  }
  setBalance(account: string, balance: Kobo, name = 'Test Account') {
    this.accounts.set(account, { name: this.accounts.get(account)?.name ?? name, balance });
  }
  get transfers(): TransferRequest[] {
    return [...this.byKey.values()].map((r) => r.req);
  }

  async getBalance(account: string): Promise<Kobo> {
    this.calls.balance++;
    this.takeFailure('balance');
    const a = this.accounts.get(account);
    if (!a) throw new BankError('ACCOUNT_NOT_FOUND', 'Unknown account');
    return a.balance;
  }

  async nameEnquiry(dest: string): Promise<NameEnquiry> {
    this.calls.nameEnquiry++;
    this.takeFailure('nameEnquiry');
    if (dest === '0000000002') throw new BankError('TIMEOUT', 'Name enquiry timed out');
    const a = this.accounts.get(dest);
    if (!a || dest === '0000000001') throw new BankError('ACCOUNT_NOT_FOUND', 'Unknown account');
    const ref = `NE-${++this.n}`;
    this.enquiries.set(ref, { dest, at: this.now().getTime(), used: false });
    return { nameEnquiryRef: ref, accountName: a.name };
  }

  private planFor(amount: Kobo, forced?: TestOutcome): Rec['plan'] {
    if (forced === 'failed') return 'failed';
    if (forced === 'pending') return 'pending_then_ok';
    if (forced === 'timeout') return 'timeout_then_failed';
    if (forced === 'reversed') return 'ok_then_reversed';
    const tail = Number(amount % 100n);
    return tail === 2 ? 'timeout_then_failed' : tail === 3 ? 'pending_then_ok' : tail === 4 ? 'ok_then_reversed' : 'ok';
  }

  async transfer(req: TransferRequest): Promise<TransferResult> {
    this.calls.transfer++;
    this.takeFailure('transfer');
    const bodyKey = `${req.sourceAccount}|${req.destinationAccount}|${req.amount}|${req.reference}`;
    const prior = this.byKey.get(req.idempotencyKey);
    if (prior) {
      if (prior.bodyKey !== bodyKey) throw new BankError('DUPLICATE_REQUEST', 'Idempotency-Key reused with a different body');
      return this.timeoutOr(prior, this.view(prior));
    }
    if (req.reference.startsWith('DUP-') || this.byRef.has(req.reference)) throw new BankError('DUPLICATE_REQUEST', 'Reference already used');
    const src = this.accounts.get(req.sourceAccount);
    if (!src) throw new BankError('ACCOUNT_NOT_FOUND', 'Unknown source account');
    const ne = this.enquiries.get(req.nameEnquiryRef);
    if (!ne || ne.used || ne.dest !== req.destinationAccount) throw new BankError('NAME_ENQUIRY_EXPIRED', 'Name enquiry missing, used or for another account');
    if (this.now().getTime() - ne.at > 10 * 60_000) throw new BankError('NAME_ENQUIRY_EXPIRED', 'Name enquiry expired');
    const plan = this.planFor(req.amount, req.testOutcome);
    const tail = Number(req.amount % 100n);
    if (tail === 1 && !req.testOutcome) throw new BankError('INSUFFICIENT_FUNDS', 'Balance below amount plus charges');
    if (src.balance < req.amount && plan !== 'failed') throw new BankError('INSUFFICIENT_FUNDS', 'Balance below amount plus charges');
    ne.used = true;
    const rec: Rec = { req, bodyKey, plan, createdAt: this.now().getTime(), moved: false, reversed: false };
    this.byKey.set(req.idempotencyKey, rec);
    this.byRef.set(req.reference, rec);
    if (plan === 'ok' || plan === 'ok_then_reversed') this.move(rec);
    return this.timeoutOr(rec, this.view(rec));
  }

  async getTransfer(reference: string): Promise<TransferResult | null> {
    this.calls.getTransfer++;
    this.takeFailure('getTransfer');
    const rec = this.byRef.get(reference);
    return rec ? this.view(rec) : null;
  }

  private timeoutOr(rec: Rec, r: TransferResult): TransferResult {
    if (rec.plan === 'timeout_then_failed' || rec.plan === 'timeout_then_ok') throw new BankError('TIMEOUT', 'Gateway timeout');
    return r;
  }

  private move(rec: Rec) {
    if (rec.moved) return;
    rec.moved = true;
    this.accounts.get(rec.req.sourceAccount)!.balance -= rec.req.amount;
    const d = this.accounts.get(rec.req.destinationAccount);
    if (d) d.balance += rec.req.amount;
  }
  private unmove(rec: Rec) {
    if (!rec.moved || rec.reversed) return;
    rec.reversed = true;
    this.accounts.get(rec.req.sourceAccount)!.balance += rec.req.amount;
    const d = this.accounts.get(rec.req.destinationAccount);
    if (d) d.balance -= rec.req.amount;
  }

  /** The state of a transfer at the current clock time. */
  private view(rec: Rec): TransferResult {
    const age = this.now().getTime() - rec.createdAt;
    let status: TransferResult['status'];
    switch (rec.plan) {
      case 'ok': status = 'successful'; break;
      case 'failed': status = 'failed'; break;
      case 'pending_then_ok':
        if (age >= 120_000) { this.move(rec); status = 'successful'; } else status = 'pending';
        break;
      case 'ok_then_reversed':
        if (age >= 60_000) { this.unmove(rec); status = 'reversed'; } else status = 'successful';
        break;
      case 'timeout_then_failed': status = age >= 30_000 ? 'reversed' : 'pending'; if (status === 'reversed') status = 'failed'; break;
      case 'timeout_then_ok': this.move(rec); status = 'successful'; break;
    }
    return {
      reference: rec.req.reference, status, amount: rec.req.amount, fee: 0n, vat: 0n, stampDuty: 0n, totalDebit: rec.req.amount,
      failureCode: status === 'failed' ? 'TRANSFER_FAILED' : undefined,
    };
  }
}
