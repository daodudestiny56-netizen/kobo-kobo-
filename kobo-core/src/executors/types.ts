import type { Kobo } from '../money';

/**
 * The seam between the core service and the Rails service that owns the bank rails (Access WaaS).
 * Core decides WHAT to move and records it; the executor moves the money.
 *
 * Contract rules the Rails side must honour:
 *  - Idempotency: the same `idempotencyKey` must never move money twice. A replay returns the original result;
 *    a replay with a different amount is an IDEMPOTENCY_CONFLICT.
 *  - TIMEOUT/UNAVAILABLE mean "outcome unknown": core retries with the same key. Everything else is final.
 */
export type ExecutorErrorCode = 'TIMEOUT' | 'UNAVAILABLE' | 'INSUFFICIENT_FUNDS' | 'REJECTED' | 'ACCOUNT_BLOCKED' | 'IDEMPOTENCY_CONFLICT';

const RETRYABLE = new Set<ExecutorErrorCode>(['TIMEOUT', 'UNAVAILABLE']);

export class ExecutorError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: ExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutorError';
    this.retryable = RETRYABLE.has(code);
  }
}

export interface DebitRequest {
  /** `sweep:<merchantId>:<sweepDate>` */
  idempotencyKey: string;
  merchantId: string;
  nuban: string;
  amount: Kobo;
  narration: string;
  pensionReference: string;
}
export interface DebitResult {
  debitReference: string;
  amount: Kobo;
}
export interface CreditRequest {
  /** `withdrawal:<withdrawalId>` */
  idempotencyKey: string;
  nuban: string;
  amount: Kobo;
  narration: string;
}
export interface CreditResult {
  creditReference: string;
}
export interface DebitRecord {
  idempotencyKey: string;
  nuban: string;
  amount: Kobo;
  debitReference: string;
}

export interface SweepExecutor {
  /** Available balance of the merchant's Access account. */
  getBalance(nuban: string): Promise<Kobo>;
  /** Move `amount` from the merchant's account to the Access ARM collection account. */
  debit(req: DebitRequest): Promise<DebitResult>;
  /** Pay `amount` from the Access ARM collection account into the merchant's account (emergency withdrawal). */
  credit(req: CreditRequest): Promise<CreditResult>;
  /** Every debit executed for a sweep date; feeds the reconciliation report. */
  listDebits(sweepDate: string): Promise<DebitRecord[]>;
}
