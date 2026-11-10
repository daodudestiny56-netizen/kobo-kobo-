import type { GuardAlertType, GuardContext, GuardVerdict, SweepGuard } from './guard';
import { koboToNaira } from './money';

const TYPES = new Set<GuardAlertType>(['ANOMALOUS_INFLOW', 'SUSPECTED_DUPLICATE', 'NAME_MISMATCH', 'LOW_BUFFER']);

/**
 * Calls the AI service (Sweep Guard). POST {url} with the night's inflows, expects
 *   { verdict: "CLEAR" } | { verdict: "HOLD", alert_type, details? }.
 * If the service is down, slow or answers nonsense we FAIL OPEN (CLEAR) and log: an AI outage must not stop every
 * trader's savings, and the bank debit is still capped and idempotent. Set failClosed to hold instead.
 */
export class HttpGuard implements SweepGuard {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs = 3000,
    private readonly failClosed = false,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly log: (m: string) => void = (m) => console.warn(m),
  ) {}

  async evaluate(ctx: GuardContext): Promise<GuardVerdict> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({
          merchant_id: ctx.merchantId,
          sweep_date: ctx.sweepDate,
          takings: koboToNaira(ctx.takings),
          inflows: ctx.inflows.map((i) => ({ bank_reference: i.bankReference, amount: koboToNaira(i.amount), settled_at: i.settledAt.toISOString() })),
        }),
      });
      if (!res.ok) throw new Error(`guard service answered ${res.status}`);
      const j: any = await res.json();
      if (j?.verdict === 'CLEAR') return { verdict: 'CLEAR' };
      if (j?.verdict === 'HOLD' && TYPES.has(j.alert_type)) {
        return { verdict: 'HOLD', alertType: j.alert_type, details: j.details && typeof j.details === 'object' ? j.details : {} };
      }
      throw new Error('guard service returned an invalid verdict');
    } catch (e) {
      this.log(`[guard] ${(e as Error).message}; ${this.failClosed ? 'holding' : 'allowing'} merchant ${ctx.merchantId}`);
      return this.failClosed ? { verdict: 'HOLD', alertType: 'ANOMALOUS_INFLOW', details: { rule: 'guard_unavailable' } } : { verdict: 'CLEAR' };
    } finally {
      clearTimeout(timer);
    }
  }
}
