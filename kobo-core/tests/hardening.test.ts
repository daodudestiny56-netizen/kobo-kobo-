import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, productionProblems } from '../src/config';
import { buildServer } from '../src/server';
import { addMonthsToInstant } from '../src/time';
import { DURING, makeDeps, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('production guard', () => {
  const prod = (env: Record<string, string>) => productionProblems(loadConfig({ NODE_ENV: 'production', ...env } as NodeJS.ProcessEnv));

  it('development is never blocked', () => {
    expect(productionProblems(loadConfig({} as NodeJS.ProcessEnv))).toEqual([]);
  });

  it('production with open endpoints, no pepper or the mock bank is refused, each reason named', () => {
    const p = prod({});
    expect(p).toHaveLength(4);
    expect(p.join(' ')).toMatch(/SERVICE_TOKEN.*WEBHOOK_TOKEN.*PIN_PEPPER.*EXECUTOR_MODE/);
  });

  it('a properly configured production process passes', () => {
    expect(prod({ SERVICE_TOKEN: 's', WEBHOOK_TOKEN: 'w', PIN_PEPPER: 'p', EXECUTOR_MODE: 'http' })).toEqual([]);
  });
});

describe('request logs', () => {
  it('record method and path only: no webhook token, no USSD text (PINs), no auth header, no phone number', async () => {
    let logged = '';
    const stream = new Writable({ write(chunk, _enc, cb) { logged += chunk.toString(); cb(); } });
    const deps = makeDeps(pool, { now: DURING, config: { logLevel: 'info', webhookToken: 'super-secret-token', serviceToken: 'svc-secret' } });
    const app = buildServer(deps, { logStream: stream });
    const m = await makeTrader(pool, { pin: '7391', pension: { emergency: '500.00', retirement: '500.00', firstContributionAt: addMonthsToInstant(DURING, -4) } });

    await app.inject({ method: 'POST', url: '/api/v1/ussd?token=super-secret-token', payload: { phoneNumber: m.phone_number, text: '5*100*1*7391' } });
    await app.inject({ method: 'POST', url: `/api/v1/merchants/${m.id}/pin/verify`, headers: { authorization: 'Bearer svc-secret' }, payload: { pin: '7391' } });
    await app.inject({ method: 'POST', url: '/api/v1/ussd?token=wrong-token', payload: { phoneNumber: m.phone_number, text: '' } });
    await app.close();

    expect(logged).toContain('/api/v1/ussd');
    for (const secret of ['super-secret-token', 'wrong-token', 'svc-secret', '7391', m.phone_number, '5*100*1']) {
      expect(logged, `log leaked ${secret}`).not.toContain(secret);
    }
  });

  it('oversized bodies are rejected before they are parsed', async () => {
    const app = buildServer(makeDeps(pool));
    const res = await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: '+2348031230001', text: 'x'.repeat(100_000) } });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});
