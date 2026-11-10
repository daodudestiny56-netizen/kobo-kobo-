export type Kobo = number; // integer kobo everywhere; floats never leave the bank client

export type TransferStatus = "pending" | "successful" | "failed" | "reversed";

export type Transfer = {
  reference: string;
  transactionId: string;
  status: TransferStatus;
  amountKobo: Kobo;
  feeKobo: Kobo;
  vatKobo: Kobo;
  stampDutyKobo: Kobo;
  totalDebitKobo: Kobo;
  sourceAccount: string;
  destinationAccount: string;
  sourceBalanceAfterKobo: Kobo;
  createdAt: string;
  completedAt: string | null;
};

export type ResolvedAccount = {
  accountNumber: string;
  accountName: string; // the bank returns UPPERCASE, often with a middle name
  bankName: string;
  status: string;
};

export type NameEnquiry = {
  ref: string; // single-use, expires in 10 minutes
  accountNumber: string;
  accountName: string;
  kycLevel: number | null;
  expiresAt: string;
};

/**
 * The CALLER persists this object before sending, and resends the identical
 * object on any retry. The bank compares the whole body for the same
 * Idempotency-Key, so a fresh nameEnquiryRef on a retry causes a 409.
 */
export type TransferRequest = {
  idempotencyKey: string;
  reference: string; // must not start with "DUP-"
  sourceAccount: string;
  destinationAccount: string;
  nameEnquiryRef: string;
  amountKobo: Kobo;
  narration: string;
};

export type SendResult =
  | { outcome: "settled"; transfer: Transfer }                  // money moved, ledger may post
  | { outcome: "pending"; transfer: Transfer }                  // accepted, not final: call awaitFinal
  | { outcome: "unknown"; reference: string; reason: string }   // timeout/5xx/network: NEVER resend, call awaitFinal
  | { outcome: "failed"; code: string; message: string };      // definitive, nothing moved: no ledger entries

export type BankTransaction = {
  reference: string;
  account: string;
  type: string;                  // "transfer" | "opening_balance" | "reversal" ...
  direction: "credit" | "debit";
  amountKobo: Kobo;
  feeKobo: Kobo;
  counterparty: string | null;
  channel: string | null;
  status: string;
  at: string;                    // ISO UTC
};

export type AwaitOptions = {
  maxWaitMs?: number;            // default 150_000
  firstDelayMs?: number;         // default 2_000, then doubles up to 15_000
};

export interface BankClient {
  getBalanceKobo(account: string): Promise<Kobo>;                      // team accounts only
  resolveAccount(account: string, bankCode?: string): Promise<ResolvedAccount>;
  nameEnquiry(account: string): Promise<NameEnquiry>;                  // intrabank
  sendIntra(req: TransferRequest): Promise<SendResult>;                // never auto-retried
  getTransfer(reference: string): Promise<Transfer | null>;            // null = bank has no record
  awaitFinal(reference: string, opts?: AwaitOptions): Promise<Transfer | null>;
  listTransactions(opts?: { sinceIso?: string }): Promise<BankTransaction[]>;  // team-wide, newest first
  listAccountTransactions(account: string, opts?: { sinceIso?: string }): Promise<BankTransaction[]>;
}

export class BankError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number,
    public requestId?: string,
    public field?: string
  ) {
    super(message);
  }
}

/** Network failure or timeout. For money-moving calls this means "outcome unknown". */
export class BankNetworkError extends Error {}