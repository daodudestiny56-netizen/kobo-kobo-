import { BankError as RootBankError, BankNetworkError, type BankClient } from '../../../src/bank/types.js';
import { BankError, type BankPort, type BankErrorCode, type TransferRequest, type TransferResult } from '../bank/port';
import type { Kobo } from '../money';

const ERROR_CODES: Record<string, BankErrorCode> = {
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  BENEFICIARY_UNAVAILABLE: 'BENEFICIARY_UNAVAILABLE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  NAME_ENQUIRY_EXPIRED: 'NAME_ENQUIRY_EXPIRED',
};

function mapError(error: unknown): BankError {
  if (error instanceof BankError) return error;
  if (error instanceof BankNetworkError) return new BankError('UNAVAILABLE', error.message);
  if (error instanceof RootBankError) {
    const code = ERROR_CODES[error.code] ?? (error.httpStatus === 504 ? 'TIMEOUT' : error.httpStatus === 503 ? 'UNAVAILABLE' : 'REJECTED');
    return new BankError(code, error.message, error.requestId);
  }
  throw error;
}

function safeNumber(amount: Kobo): number {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Bank transfer amount is outside the safe integer range');
  return value;
}

function mapTransfer(t: Awaited<ReturnType<BankClient['getTransfer']>> & {}): TransferResult {
  return {
    reference: t.reference,
    status: t.status,
    amount: BigInt(t.amountKobo),
    fee: BigInt(t.feeKobo),
    vat: BigInt(t.vatKobo),
    stampDuty: BigInt(t.stampDutyKobo),
    totalDebit: BigInt(t.totalDebitKobo),
    failureCode: t.status === 'failed' ? 'TRANSFER_FAILED' : undefined,
  };
}

export class RootBankPort implements BankPort {
  constructor(private readonly client: BankClient, private readonly allowTestOutcomes: boolean) {}

  async getBalance(account: string): Promise<Kobo> {
    try {
      return BigInt(await this.client.getBalanceKobo(account));
    } catch (error) {
      throw mapError(error);
    }
  }

  async nameEnquiry(destinationAccount: string) {
    try {
      const enquiry = await this.client.nameEnquiry(destinationAccount);
      return { nameEnquiryRef: enquiry.ref, accountName: enquiry.accountName };
    } catch (error) {
      throw mapError(error);
    }
  }

  async transfer(request: TransferRequest): Promise<TransferResult> {
    if (request.testOutcome && !this.allowTestOutcomes) {
      throw new BankError('REJECTED', 'Forced transfer outcomes are only enabled in demo mode.');
    }
    const amountKobo = safeNumber(request.amount);
    const result = await this.client.sendIntra({
      sourceAccount: request.sourceAccount,
      destinationAccount: request.destinationAccount,
      nameEnquiryRef: request.nameEnquiryRef,
      amountKobo,
      narration: request.narration,
      reference: request.reference,
      idempotencyKey: request.idempotencyKey,
      testOutcome: request.testOutcome,
    });
    if (result.outcome === 'unknown') throw new BankError('TIMEOUT', result.reason);
    if (result.outcome === 'failed') {
      const code = ERROR_CODES[result.code] ?? 'REJECTED';
      throw new BankError(code, result.message);
    }
    return mapTransfer(result.transfer);
  }

  async getTransfer(reference: string): Promise<TransferResult | null> {
    try {
      const transfer = await this.client.getTransfer(reference);
      return transfer ? mapTransfer(transfer) : null;
    } catch (error) {
      throw mapError(error);
    }
  }
}
