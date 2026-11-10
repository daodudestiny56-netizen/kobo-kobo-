import { describe, expect, it } from 'vitest';
import { HttpGuard } from '../src/guard-http';

const ctx = { merchantId: 'm1', sweepDate: '2026-11-08', takings: 12_000_00n, inflows: [{ bankReference: 'B1', amount: 12_000_00n, settledAt: new Date('2026-11-08T10:00:00Z') }] };
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const quiet = () => {};

describe('HttpGuard', () => {
  it('sends naira strings and maps CLEAR / HOLD', async () => {
    let sent: any;
    const f = (async (_u: any, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ verdict: 'HOLD', alert_type: 'SUSPECTED_DUPLICATE', details: { score: 0.93 } })); }) as unknown as typeof fetch;
    const v = await new HttpGuard('http://x', 't', 1000, false, f, quiet).evaluate(ctx);
    expect(sent.takings).toBe('12000.00');
    expect(sent.inflows[0].amount).toBe('12000.00');
    expect(v).toEqual({ verdict: 'HOLD', alertType: 'SUSPECTED_DUPLICATE', details: { score: 0.93 } });
    expect(await new HttpGuard('http://x', '', 1000, false, reply(200, { verdict: 'CLEAR' }), quiet).evaluate(ctx)).toEqual({ verdict: 'CLEAR' });
  });
  it('fails open on errors and bad answers, closed when configured', async () => {
    for (const f of [reply(500, {}), reply(200, { verdict: 'HOLD', alert_type: 'NOPE' }), (async () => { throw new Error('down'); }) as unknown as typeof fetch]) {
      expect(await new HttpGuard('http://x', '', 1000, false, f, quiet).evaluate(ctx)).toEqual({ verdict: 'CLEAR' });
      expect((await new HttpGuard('http://x', '', 1000, true, f, quiet).evaluate(ctx)).verdict).toBe('HOLD');
    }
  });
});
