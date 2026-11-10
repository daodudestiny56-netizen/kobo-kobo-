import { engine } from './engine';
import type { Api } from './types';

// NEXT_PUBLIC_API_MODE=live talks to the Node backend (PRD section 15). Anything else uses the in-browser mock.
const live = process.env.NEXT_PUBLIC_API_MODE === 'live';

const wrap = <T,>(fn: () => T): Promise<T> =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (e) {
        reject(e);
      }
    }, 140),
  );

const mock: Api = {
  listDemoTraders: () => wrap(() => engine.traders()),
  listMerchants: () => wrap(() => engine.merchants()),
  onboard: (req) => wrap(() => engine.onboard(req)),
  summary: (id) => wrap(() => engine.summary(id)),
  activity: (id) => wrap(() => engine.activity(id)),
  feed: (id) => wrap(() => engine.feed(id)),
  resolveAccount: (account) => wrap(() => engine.resolveAccount(account)),
  verifyOtp: (phone, code) => wrap(() => engine.verifyOtp(phone, code)),
  demoSignIn: (account) => wrap(() => engine.demoSignIn(account)),
  updateSettings: (id, patch) => wrap(() => engine.updateSettings(id, patch)),
  withdraw: (id, amountKobo) => wrap(() => engine.withdraw(id, amountKobo)),
  ussd: (phone, _sessionId, text) => wrap(() => engine.ussd(phone, text)),
  sms: (phone, text) => wrap(() => engine.sms(phone, text)),
  demoInflow: (id, amountKobo) => wrap(() => engine.demoInflow(id, amountKobo)),
  demoClock: (days) => wrap(() => engine.demoClock(days)),
  demoReset: () => wrap(() => engine.demoReset()),
  opsOverview: () => wrap(() => engine.ops()),
  opsRunSweep: (force) => wrap(() => engine.runSweep(force)),
  opsRequery: (sweepId) => wrap(() => engine.requery(sweepId)),
  opsResolveAlert: (alertId, decision) => wrap(() => engine.resolveAlert(alertId, decision)),
};

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? json?.message ?? `Request failed (${res.status})`);
  return (json.data ?? json) as T;
}

// Endpoints follow PRD section 15. Assumed additions the backend needs for this UI are listed in web/README.md.
const liveApi: Api = {
  listDemoTraders: () => http('GET', '/demo/traders'),
  listMerchants: () => http('GET', '/ops/merchants'),
  onboard: (req) => http('POST', '/merchants/onboard', req),
  summary: (id) => http('GET', `/merchants/${id}/summary`),
  activity: (id) => http('GET', `/merchants/${id}/activity`),
  feed: (id) => http('GET', `/merchants/${id}/feed`),
  resolveAccount: (account) => http('GET', `/identity/resolve?account=${encodeURIComponent(account)}`),
  verifyOtp: (phone, code) => http('POST', '/auth/verify-otp', { phone, code }),
  demoSignIn: (account) => http('POST', '/demo/sign-in', { account }),
  updateSettings: (id, patch) => http('PATCH', `/merchants/${id}/settings`, patch),
  withdraw: (id, amountKobo) => http('POST', '/withdrawals', { merchantId: id, amountKobo }),
  ussd: (phone, sessionId, text) => http('POST', '/ussd', { phoneNumber: phone, sessionId, text }),
  sms: (phone, text) => http('POST', '/sms/inbound', { from: phone, text }),
  demoInflow: (id, amountKobo) => http('POST', '/demo/inflow', { merchantId: id, amountKobo }),
  demoClock: (days) => http('POST', '/demo/clock', { days }),
  demoReset: () => http('POST', '/demo/reset'),
  opsOverview: () => http('GET', '/ops/overview'),
  opsRunSweep: (force) => http('POST', '/ops/sweeps/run', { forceOutcome: force }),
  opsRequery: (sweepId) => http('POST', `/ops/sweeps/${sweepId}/requery`),
  opsResolveAlert: (alertId, decision) => http('POST', `/ops/alerts/${alertId}/resolve`, { decision }),
};

export const api: Api = live ? liveApi : mock;
export const isLive = live;
