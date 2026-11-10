import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { HttpExecutor } from '../src/executors/http';
import { ExecutorError } from '../src/executors/types';
import { executeSweepForMerchant } from '../src/sweeps/service';
import { addInflow, DAY, DURING, makeDeps, makeTrader, resetDb, testPool } from './helpers';

/** A stand-in for the Rails executor that follows the documented contract. */
const fake = Fastify();
const debits = new Map<string, { nuban: string; amount: string; debit_reference: string }>();
const seen: { auth?: string; idem?: string; body?: any }[] = [];
let mode: 'ok' | 'insufficient' | 'down' | 'slow' = 'ok';
let balance = '12000.00';

fake.get('/api/v1/executor/balance', async () => ({ available_balance: balance }));
fake.post('/api/v1/executor/debit', async (req, reply) => {
  seen.push({ auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string, body: req.body });
  if (mode === 'down') return reply.code(503).send({ error: { code: 'UNAVAILABLE', message: 'bank down' } });
  if (mode === 'insufficient') return reply.code(402).send({ error: { code: 'INSUFFICIENT_FUNDS', message: 'low balance' } });
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 300));
  const key = req.headers['idempotency-key'] as string;
  const b = req.body as { nuban: string; amount: string };
  const prior = debits.get(key);
  if (prior) return prior.amount === b.amount ? { debit_reference: prior.debit_reference, amount: prior.amount } : reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'amount differs' } });
  const rec = { nuban: b.nuban, amount: b.amount, debit_reference: `RAILS-${debits.size + 1}` };
  debits.set(key, rec);
  return { debit_reference: rec.debit_reference, amount: rec.amount, status: 'SUCCESS' };
});
fake.get('/api/v1/executor/debits', async () => ({
  debits: [...debits.entries()].map(([k, v]) => ({ idempotency_key: k, ...v })),
}));

let baseUrl = '';
beforeAll(async () => {
  await fake.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});
afterAll(() => fake.close());
beforeEach(() => {
  mode = 'ok';
  balance = '12000.00';
  debits.clear();
  seen.length = 0;
});

const req = { idempotencyKey: 'sweep:m1:2026-11-06', merchantId: 'm1', nuban: '1000000001', amount: 90_000n, narration: 'n', pensionReference: 'PEN-1' };

describe('HttpExecutor against the documented contract', () => {
  it('reads balances and debits with the bearer token and idempotency key', async () => {
    const ex = new HttpExecutor(baseUrl, 'tok');
    expect(await ex.getBalance('1000000001')).toBe(1_200_000n);
    const res = await ex.debit(req);
    expect(res).toEqual({ debitReference: 'RAILS-1', amount: 90_000n });
    expect(seen[0].auth).toBe('Bearer tok');
    expect(seen[0].idem).toBe('sweep:m1:2026-11-06');
    expect(seen[0].body).toEqual({ merchant_id: 'm1', nuban: '1000000001', amount: '900.00', narration: 'n', pension_reference: 'PEN-1' });
  });

  it('a replay returns the original reference; a changed amount is an IDEMPOTENCY_CONFLICT', async () => {
    const ex = new HttpExecutor(baseUrl, '');
    const a = await ex.debit(req);
    expect((await ex.debit(req)).debitReference).toBe(a.debitReference);
    await expect(ex.debit({ ...req, amount: 80_000n })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    expect(debits.size).toBe(1);
  });

  it('maps failures to retryable vs final', async () => {
    const ex = new HttpExecutor(baseUrl, '', 100);
    mode = 'insufficient';
    await expect(ex.debit(req)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', retryable: false });
    mode = 'down';
    await expect(ex.debit(req)).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    mode = 'slow';
    await expect(ex.debit(req)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await expect(new HttpExecutor('http://127.0.0.1:1', '', 100).getBalance('x')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    await expect(new HttpExecutor(baseUrl, '').debit({ ...req, idempotencyKey: 'k' }).then(() => 'ok')).resolves.toBe('ok');
    expect(ExecutorError.name).toBe('ExecutorError');
  });

  it('lists the debits for a sweep date for reconciliation', async () => {
    const ex = new HttpExecutor(baseUrl, '');
    await ex.debit(req);
    expect(await ex.listDebits('2026-11-06')).toEqual([
      { idempotencyKey: 'sweep:m1:2026-11-06', nuban: '1000000001', amount: 90_000n, debitReference: 'RAILS-1' },
    ]);
  });
});

describe('a full sweep through HttpExecutor', () => {
  const pool = testPool();
  afterAll(() => pool.end());

  it('plans, debits over HTTP and settles', async () => {
    await resetDb(pool);
    const deps = makeDeps(pool);
    deps.executor = new HttpExecutor(baseUrl, 'tok') as never;
    const m = await makeTrader(pool);
    await addInflow(pool, m.id, '45000.00', DURING);
    balance = '50000.00';
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'EXECUTED', sweepAmount: 90_000n, debitReference: 'RAILS-1' });
    expect(seen[0].idem).toBe(`sweep:${m.id}:${DAY}`);
    expect(seen[0].body.pension_reference).toBe('PEN-20261106-000001');
  });
});
