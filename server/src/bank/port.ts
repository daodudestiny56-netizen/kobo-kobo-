import type { Kobo } from '../money';

/**
 * The seam between the sweep engine and the Xtradot Bank sandbox (PRD section 7). The engine only knows this
 * interface. The real client (Abiodun: x-api-key, envelope parsing, 429 back-off, rate budget) and the
 * SimulatedBank below both implement it.
 *
 * Rules the implementation must honour:
 *  - `transfer` is idempotent on `idempotencyKey`: a replay returns the original result, never a second transfer.
 *  - A 504 TIMEOUT means "outcome unknown". Throw BankError('TIMEOUT'). The engine will requery, never resend blindly.
 *  - `getTransfer` returns null only when the bank has no record of the reference (HTTP 404).
 */
export type BankErrorCode =
  | 'TIMEOUT' // 504: outcome unknown, requery
  | 'UNAVAILABLE' // 503 / network: the request was not processed
  | 'RATE_LIMITED' // 429: the request was not processed
  | 'INSUFFICIENT_FUNDS' // 402
  | 'ACCOUNT_RESTRICTED' // 403: PND, dormant or frozen source
  | 'ACCOUNT_NOT_FOUND' // 404
  | 'BENEFICIARY_UNAVAILABLE' // 422: dormant or frozen destination
  | 'LIMIT_EXCEEDED' // 422: KYC limit
  | 'DUPLICATE_REQUEST' // 409: reused key or reference with a different body
  | 'NAME_ENQUIRY_EXPIRED' // 409
  | 'REJECTED'; // anything else final

const NOT_PROCESSED = new Set<BankErrorCode>(['UNAVAILABLE', 'RATE_LIMITED']);

export class BankError extends Error {
  constructor(
    public readonly code: BankErrorCode,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'BankError';
  }
  /** Outcome unknown: look the transfer up before doing anything else. */
  get unknownOutcome() {
    return this.code === 'TIMEOUT';
  }
  /** The bank did not process the request, so it is safe to try again later. */
  get notProcessed() {
    return NOT_PROCESSED.has(this.code);
  }
}

export type TransferStatus = 'successful' | 'pending' | 'failed' | 'reversed';

export interface TransferResult {
  reference: string;
  status: TransferStatus;
  amount: Kobo;
  /** Read from the bank response, never hard-coded. Intra-bank transfers carry no fee. */
  fee: Kobo;
  vat: Kobo;
  stampDuty: Kobo;
  totalDebit: Kobo;
  failureCode?: string;
}

export interface NameEnquiry {
  nameEnquiryRef: string;
  accountName: string;
  kycLevel?: number | null;
}

/** x-test-outcome header values (demo mode only). */
export type TestOutcome = 'successful' | 'failed' | 'pending' | 'timeout' | 'reversed';

export interface TransferRequest {
  sourceAccount: string;
  destinationAccount: string;
  nameEnquiryRef: string;
  amount: Kobo;
  narration: string;
  /** Must not start with "DUP-" (the sandbox treats that as a forced duplicate). */
  reference: string;
  idempotencyKey: string;
  testOutcome?: TestOutcome;
}

/** Demo only: a real transfer from a payer account to a trader, so the collector and statements see a genuine credit. */
export interface PayIn {
  sourceAccount: string;
  destinationAccount: string;
  amount: Kobo;
  reference: string;
  idempotencyKey: string;
}

export interface BankPort {
  /** Optional: only banks that can move demo money implement it (the real sandbox client does). */
  payIn?(req: PayIn): Promise<TransferResult>;
  getBalance(account: string): Promise<Kobo>;
  nameEnquiry(destinationAccount: string): Promise<NameEnquiry>;
  transfer(req: TransferRequest): Promise<TransferResult>;
  getTransfer(reference: string): Promise<TransferResult | null>;
}
