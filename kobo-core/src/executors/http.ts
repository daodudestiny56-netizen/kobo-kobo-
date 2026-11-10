import { dbToKobo, koboToNaira, type Kobo } from '../money';
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

const FINAL_CODES = new Set<ExecutorErrorCode>(['INSUFFICIENT_FUNDS', 'REJECTED', 'ACCOUNT_BLOCKED', 'IDEMPOTENCY_CONFLICT']);

/**
 * Talks to the Rails executor. Endpoints (see docs/RAILS_HANDOFF.md):
 *   GET  /api/v1/executor/balance?nuban=            -> { available_balance: "12000.00" }
 *   POST /api/v1/executor/debit   (Idempotency-Key) -> { debit_reference, amount }
 *   POST /api/v1/executor/credit  (Idempotency-Key) -> { credit_reference }
 *   GET  /api/v1/executor/debits?sweep_date=        -> { debits: [{ idempotency_key, nuban, amount, debit_reference }] }
 * Errors: non-2xx with { error: { code, message } }. Network failures, timeouts, 408/429/5xx are retryable.
 */
export class HttpExecutor implements SweepExecutor {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, o: { query?: Record<string, string>; body?: unknown; idempotencyKey?: string } = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(o.idempotencyKey ? { 'idempotency-key': o.idempotencyKey } : {}),
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      const aborted = (e as { name?: string }).name === 'AbortError';
      throw new ExecutorError(aborted ? 'TIMEOUT' : 'UNAVAILABLE', aborted ? 'Executor timed out' : `Executor unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (status >= 200 && status < 300) return json;

    const code = json?.error?.code as ExecutorErrorCode | undefined;
    const message = json?.error?.message ?? `Executor responded ${status}`;
    if (code && FINAL_CODES.has(code)) throw new ExecutorError(code, message);
    if (status === 402) throw new ExecutorError('INSUFFICIENT_FUNDS', message);
    if (status === 409) throw new ExecutorError('IDEMPOTENCY_CONFLICT', message);
    if (status === 423) throw new ExecutorError('ACCOUNT_BLOCKED', message);
    if (status === 408 || status === 429 || status >= 500) throw new ExecutorError('UNAVAILABLE', message);
    throw new ExecutorError('REJECTED', message);
  }

  async getBalance(nuban: string): Promise<Kobo> {
    const r = await this.call('GET', '/api/v1/executor/balance', { query: { nuban } });
    return dbToKobo(String(r.available_balance));
  }

  async debit(req: DebitRequest): Promise<DebitResult> {
    const r = await this.call('POST', '/api/v1/executor/debit', {
      idempotencyKey: req.idempotencyKey,
      body: {
        merchant_id: req.merchantId,
        nuban: req.nuban,
        amount: koboToNaira(req.amount),
        narration: req.narration,
        pension_reference: req.pensionReference,
      },
    });
    return { debitReference: String(r.debit_reference), amount: dbToKobo(String(r.amount)) };
  }

  async credit(req: CreditRequest): Promise<CreditResult> {
    const r = await this.call('POST', '/api/v1/executor/credit', {
      idempotencyKey: req.idempotencyKey,
      body: { nuban: req.nuban, amount: koboToNaira(req.amount), narration: req.narration },
    });
    return { creditReference: String(r.credit_reference) };
  }

  async listDebits(sweepDate: string): Promise<DebitRecord[]> {
    const r = await this.call('GET', '/api/v1/executor/debits', { query: { sweep_date: sweepDate } });
    return (r.debits ?? []).map((d: any) => ({
      idempotencyKey: String(d.idempotency_key),
      nuban: String(d.nuban),
      amount: dbToKobo(String(d.amount)),
      debitReference: String(d.debit_reference),
    }));
  }
}
