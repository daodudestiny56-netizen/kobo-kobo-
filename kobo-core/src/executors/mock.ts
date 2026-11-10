import {
  ExecutorError,
  type CreditRequest,
  type CreditResult,
  type DebitRecord,
  type DebitRequest,
  type DebitResult,
  type ExecutorErrorCode,
  type SweepExecutor,
} from './types';
import type { Kobo } from '../money';

type Op = 'debit' | 'credit' | 'balance';
interface Failure {
  op: Op;
  code: ExecutorErrorCode;
  /** The money moved, but the caller never saw the response (a real-world timeout). */
  afterSuccess: boolean;
}

/** In-memory executor: local dev, demo and tests. Behaves like the Rails contract, including idempotency. */
export class MockExecutor implements SweepExecutor {
  readonly balances = new Map<string, Kobo>();
  readonly debits = new Map<string, DebitRecord>();
  readonly credits = new Map<string, { amount: Kobo; nuban: string; creditReference: string }>();
  readonly calls = { debit: 0, credit: 0, balance: 0 };
  private failures: Failure[] = [];
  private seq = 0;

  /** `defaultBalance` is what any account we were not told about holds (so a demo needs no per-account setup). */
  constructor(private readonly defaultBalance: Kobo = 0n) {}

  setBalance(nuban: string, amount: Kobo): void {
    this.balances.set(nuban, amount);
  }

  /** Make the next `times` calls of `op` fail with `code`. */
  failNext(op: Op, code: ExecutorErrorCode, o: { times?: number; afterSuccess?: boolean } = {}): void {
    for (let i = 0; i < (o.times ?? 1); i++) this.failures.push({ op, code, afterSuccess: o.afterSuccess ?? false });
  }

  private takeFailure(op: Op): Failure | undefined {
    const i = this.failures.findIndex((f) => f.op === op);
    return i === -1 ? undefined : this.failures.splice(i, 1)[0];
  }

  async getBalance(nuban: string): Promise<Kobo> {
    this.calls.balance++;
    const f = this.takeFailure('balance');
    if (f) throw new ExecutorError(f.code, 'simulated balance failure');
    return this.balances.get(nuban) ?? this.defaultBalance;
  }

  async debit(req: DebitRequest): Promise<DebitResult> {
    this.calls.debit++;
    const f = this.takeFailure('debit');
    if (f && !f.afterSuccess) throw new ExecutorError(f.code, 'simulated debit failure');

    const prior = this.debits.get(req.idempotencyKey);
    if (prior) {
      if (prior.amount !== req.amount) throw new ExecutorError('IDEMPOTENCY_CONFLICT', 'Same key, different amount');
      return { debitReference: prior.debitReference, amount: prior.amount };
    }
    const balance = this.balances.get(req.nuban) ?? this.defaultBalance;
    if (balance < req.amount) throw new ExecutorError('INSUFFICIENT_FUNDS', `Balance ${balance} is below ${req.amount}`);

    this.balances.set(req.nuban, balance - req.amount);
    const debitReference = `MOCK-DEBIT-${String(++this.seq).padStart(6, '0')}`;
    this.debits.set(req.idempotencyKey, { idempotencyKey: req.idempotencyKey, nuban: req.nuban, amount: req.amount, debitReference });
    if (f) throw new ExecutorError(f.code, 'simulated: debit succeeded but the response was lost');
    return { debitReference, amount: req.amount };
  }

  async credit(req: CreditRequest): Promise<CreditResult> {
    this.calls.credit++;
    const f = this.takeFailure('credit');
    if (f && !f.afterSuccess) throw new ExecutorError(f.code, 'simulated credit failure');

    const prior = this.credits.get(req.idempotencyKey);
    if (prior) {
      if (prior.amount !== req.amount) throw new ExecutorError('IDEMPOTENCY_CONFLICT', 'Same key, different amount');
      return { creditReference: prior.creditReference };
    }
    this.balances.set(req.nuban, (this.balances.get(req.nuban) ?? 0n) + req.amount);
    const creditReference = `MOCK-CREDIT-${String(++this.seq).padStart(6, '0')}`;
    this.credits.set(req.idempotencyKey, { amount: req.amount, nuban: req.nuban, creditReference });
    if (f) throw new ExecutorError(f.code, 'simulated: credit succeeded but the response was lost');
    return { creditReference };
  }

  async listDebits(sweepDate: string): Promise<DebitRecord[]> {
    return [...this.debits.values()].filter((d) => d.idempotencyKey.endsWith(`:${sweepDate}`));
  }
}
