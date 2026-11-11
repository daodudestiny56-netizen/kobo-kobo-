#!/usr/bin/env node
// End-to-end smoke test against a RUNNING server (local or the cluster). Node 20+, no dependencies.
//   BASE=http://localhost:8080 OPS_TOKEN=secret ACCOUNT=0123456792 node scripts/smoke.mjs
// - ACCOUNT: a bank account the server's bank knows, with at least N2,000 in it (the sweep leaves the buffer).
//   Each account can be enrolled once: after a run, POST /api/v1/demo/reset (or use another account).
// - Needs DEMO_MODE on. OPS_TOKEN (or DEMO_SECRET) is sent when set; leave it empty if DEMO_OPEN=1.
// With a real bank connected, "customer pays" is a real transfer from DEMO_PAYER_ACCOUNT, so this also proves the bank path.
const BASE = (process.env.BASE ?? 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.OPS_TOKEN ?? process.env.DEMO_SECRET ?? '';
const ACCOUNT = process.env.ACCOUNT;
if (!ACCOUNT) { console.error("Set ACCOUNT to a bank account the server's bank knows."); process.exit(2); }

const H = { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, data: json?.data ?? json, text };
};
let failed = 0;
const step = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); if (!ok) failed++; };
const stop = (m) => { console.error(m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const n = String(Date.now()).slice(-8);
const phone = `+23480${n}1`.slice(0, 14);

let r = await api('GET', '/healthz');
step('health', r.status === 200, r.text);

r = await api('POST', '/api/v1/merchants', { phone, fullName: `Smoke Trader ${n}`, bvn: `222${n}`, bankAccount: ACCOUNT, language: 'pidgin' });
step('sign-up', r.status === 201, r.status === 409 ? 'that account is already enrolled: POST /api/v1/demo/reset first' : r.text);
if (r.status !== 201) stop('Cannot continue without a trader.');
const id = r.data.id;

r = await api('POST', '/api/v1/demo/inflow', { merchantId: id, amountKobo: 5_000_000 });
step('customer pays N50,000', r.status === 201 && r.data.results?.length === 1, r.text);

// With a real bank the credit is recorded when the transfer settles (immediately, or via the collector). Wait briefly.
let sum;
for (let i = 0; i < 10; i++) {
  sum = (await api('GET', `/api/v1/merchants/${id}/summary`)).data;
  if (sum?.todayTakingsKobo >= 5_000_000) break;
  await sleep(2000);
}
step('summary shows takings and a sweep estimate', sum?.todayTakingsKobo === 5_000_000 && sum.expectedSweepKobo === 100_000, JSON.stringify({ t: sum?.todayTakingsKobo, e: sum?.expectedSweepKobo }));

r = await api('POST', '/api/v1/ussd', { phoneNumber: phone, sessionId: 'smoke', text: '1' });
step('USSD balance screen', r.data?.type === 'CON', r.text);

r = await api('POST', '/api/v1/ops/sweeps/run', { forceOutcome: 'none', merchantId: id });
const mine = (r.data?.sweeps ?? []).find((s) => s.merchantId === id);
step('sweep runs and settles', mine?.status === 'SETTLED', JSON.stringify(mine ?? r.text).slice(0, 300));

sum = (await api('GET', `/api/v1/merchants/${id}/summary`)).data;
step('pots hold the sweep (N500 emergency, N500 retirement)', sum?.emergencyKobo === 50_000 && sum?.retirementKobo === 50_000, JSON.stringify({ e: sum?.emergencyKobo, r: sum?.retirementKobo }));

r = await api('POST', '/api/v1/withdrawals', { merchantId: id, amountKobo: 10_000 });
step('withdrawal refused while the pot is closed', r.data?.ok === false, r.text);

r = await api('POST', '/api/v1/demo/clock', { days: 100 });
step('demo clock moved', r.status === 200, r.text);

r = await api('POST', '/api/v1/withdrawals', { merchantId: id, amountKobo: 10_000 });
step('withdrawal accepted once vested', r.data?.ok === true, r.text);

await api('POST', '/api/v1/demo/clock', { days: 0 });
await api('POST', '/api/v1/ops/requery');
r = await api('GET', '/api/v1/ops/reconciliation');
step('reconciliation is clean', r.data?.ok === true, JSON.stringify(r.data?.ledger ?? r.text).slice(0, 300));

r = await api('GET', `/api/v1/merchants/${id}/feed`);
const kinds = (r.data ?? []).map((x) => x.kind);
step('feed shows the payment, the saving and the withdrawal', ['sale', 'saving', 'withdrawal'].every((k) => kinds.includes(k)), kinds.join(','));

r = await api('GET', `/api/v1/merchants/${id}/messages`);
step('receipt message stored', (r.data?.messages ?? []).length >= 1, r.text.slice(0, 200));

console.log(failed ? `\n${failed} step(s) failed.` : '\nAll steps passed.');
process.exit(failed ? 1 : 0);
