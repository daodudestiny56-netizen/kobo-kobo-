#!/usr/bin/env node
// End-to-end smoke test against a RUNNING server (local or the cluster). Node 20+, no dependencies.
//   BASE=http://localhost:8080 OPS_TOKEN=secret ACCOUNT=0123456792 node scripts/smoke.mjs
// ACCOUNT must be a bank account that exists in the bank the server talks to, with at least N2,000 in it
// (the sweep leaves the buffer). Use a sandbox individual's account when testing the real sandbox.
// Needs DEMO_MODE=true on the server. Creates one new synthetic trader per run.
const BASE = (process.env.BASE ?? 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.OPS_TOKEN ?? '';
const ACCOUNT = process.env.ACCOUNT;
if (!ACCOUNT) { console.error('Set ACCOUNT to a bank account the server\'s bank knows.'); process.exit(2); }

const H = { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
};
let failed = 0;
const step = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); if (!ok) failed++; };
const stop = (m) => { console.error(m); process.exit(1); };

const n = String(Date.now()).slice(-8);
const phone = `+23480${n}1`.slice(0, 14);

let r = await api('GET', '/healthz');
step('health', r.status === 200, r.text);

r = await api('POST', '/api/v1/merchants', { phone, full_name: `Smoke Trader ${n}`, bvn: `222${n}`, bank_account: ACCOUNT, language: 'pidgin' });
step('sign-up', r.status === 201, r.text);
if (r.status !== 201) stop('Cannot continue without a trader.');
const id = r.json.data.merchant.id;

r = await api('POST', '/api/v1/demo/inflow', { merchant_id: id, amount_naira: 50000, channel: 'POS' });
step('customer pays N50,000', r.status === 201, r.text);

r = await api('GET', `/api/v1/merchants/${id}/summary`);
step('summary shows takings and a sweep estimate', r.json?.data?.takings_today === 5000000 && r.json.data.estimated_sweep === 100000, r.text.slice(0, 300));

r = await fetch(`${BASE}/api/v1/ussd`, { method: 'POST', headers: H, body: JSON.stringify({ phoneNumber: phone, text: '1' }) }).then((x) => x.text());
step('USSD balance screen', r.startsWith('CON '), r);

r = await api('POST', '/api/v1/ops/sweeps/run', { allow_early: true, merchant_id: id });
step('sweep runs and settles', r.json?.data?.by_status?.SETTLED === 1, r.text);

r = await api('GET', `/api/v1/merchants/${id}/summary`);
const pots = r.json?.data?.pots;
step('pots hold the sweep (N500 emergency, N500 retirement)', pots?.emergency === 50000 && pots?.retirement === 50000, JSON.stringify(pots));

r = await api('POST', '/api/v1/withdrawals', { merchant_id: id, amount_naira: 100 });
step('withdrawal refused while the pot is closed', r.json?.data?.accepted === false, r.text);

r = await api('POST', '/api/v1/demo/clock', { offset_days: 100 });
step('demo clock moved', r.status === 200, r.text);

r = await api('POST', '/api/v1/withdrawals', { merchant_id: id, amount_naira: 100 });
step('withdrawal accepted once vested', r.json?.data?.accepted === true, r.text);

r = await api('POST', '/api/v1/demo/clock', { offset_days: 0 });
r = await api('POST', '/api/v1/ops/requery');
r = await api('GET', '/api/v1/ops/reconciliation');
step('reconciliation is clean', r.json?.data?.ok === true, JSON.stringify(r.json?.data?.ledger ?? r.text).slice(0, 300));

r = await api('GET', `/api/v1/merchants/${id}/messages`);
step('receipt message stored', (r.json?.data?.messages ?? []).length >= 1, r.text.slice(0, 200));

console.log(failed ? `\n${failed} step(s) failed.` : '\nAll steps passed.');
process.exit(failed ? 1 : 0);
