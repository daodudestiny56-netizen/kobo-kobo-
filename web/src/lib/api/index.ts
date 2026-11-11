import { getDemoKey } from './demoKey';
import { engine } from './engine';
import { ApiError } from './errors';
import { DEMO_TRADERS } from './fixtures';
import type { Api, DemoTrader, Lang } from './types';

// NEXT_PUBLIC_API_MODE=live talks to the Node backend. Anything else uses the in-browser mock.
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
  consent: () => wrap(() => engine.consent()),
  onboard: (req) => wrap(() => engine.onboard(req)),
  summary: (id) => wrap(() => engine.summary(id)),
  activity: (id) => wrap(() => engine.activity(id)),
  feed: (id) => wrap(() => engine.feed(id)),
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

// Success is { status: 'success', data } and failure is { status: 'error', error: { code, message, field? } }
// (the engine) or { error: { code, message, field? } } (onboarding). Both become an ApiError.
const KEYED = ['/demo', '/ops'];

const RETRYABLE = [500, 502, 503, 504];

// One attempt. A reset connection (a proxy reusing a connection the server just closed) shows up as a network error
// or a 500 from the proxy, so reads are tried once more. Writes are never repeated: they may have reached the server.
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Ops and demo calls may need the shared key (x-demo-key). It is only sent if the person has typed one in.
  if (KEYED.some((p) => path.startsWith(p))) {
    const key = getDemoKey();
    if (key) headers['x-demo-key'] = key;
  }
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? `Request failed (${res.status})`, e?.field);
  }
  return (json.data ?? json) as T;
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await request<T>(method, path, body);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // A reset connection reaches us as a network error, or as a bare 500 from a proxy (no error code from the engine).
    // Reads are always safe to repeat. Settings updates only set a value, so they are safe too. Anything that moves
    // money (withdrawals, demo payments, sweeps) is never repeated, because it may already have reached the server.
    const proxyFailure = e.code === 'NETWORK' || (RETRYABLE.includes(e.status) && e.code.startsWith('HTTP_'));
    const safe = method === 'GET' ? e.code === 'NETWORK' || RETRYABLE.includes(e.status) : method === 'PATCH' && proxyFailure;
    if (!safe) throw e;
    await new Promise((r) => setTimeout(r, 250));
    return request<T>(method, path, body);
  }
}

// The server returns a whole trader from onboarding and demo sign-in (id, fullName, rsaPin, ...), not { merchantId }.
interface Trader {
  id?: string;
  merchantId?: string;
  fullName: string;
  language: Lang;
  rateBps: number;
  rsaPin?: string;
}

const liveApi: Api = {
  listDemoTraders: () => http<DemoTrader[]>('GET', '/demo/traders').catch(() => DEMO_TRADERS),
  listMerchants: () => http('GET', '/ops/merchants'),
  consent: () => http('GET', '/consent'),
  onboard: async (req) => {
    const t = await http<Trader>('POST', '/merchants/onboard', req);
    return { merchantId: (t.merchantId ?? t.id) as string, fullName: t.fullName, language: t.language, rateBps: t.rateBps, rsaPin: t.rsaPin };
  },
  summary: (id) => http('GET', `/merchants/${id}/summary`),
  activity: (id) => http('GET', `/merchants/${id}/activity`),
  feed: (id) => http('GET', `/merchants/${id}/feed`),
  verifyOtp: (phone, code) => http('POST', '/auth/verify-otp', { phone, code }),
  demoSignIn: async (account) => {
    const t = await http<Trader>('POST', '/demo/sign-in', { account });
    return { merchantId: (t.merchantId ?? t.id) as string };
  },
  updateSettings: (id, patch) => http('PATCH', `/merchants/${id}/settings`, patch),
  withdraw: (id, amountKobo) => http('POST', '/withdrawals', { merchantId: id, amountKobo }),
  ussd: (phone, sessionId, text) => http('POST', '/ussd', { phoneNumber: phone, sessionId, text }),
  sms: (phone, text) => http('POST', '/sms/inbound', { from: phone, text }),
  demoInflow: (id, amountKobo) => http('POST', '/demo/inflow', { merchantId: id, amountKobo }),
  // The server stores an absolute offset in days (0 to 400); the app asks to move forward by some days.
  demoClock: async (days) => {
    const cur = await http<{ offsetDays: number }>('GET', '/demo/clock');
    await http('POST', '/demo/clock', { days: Math.min(400, Math.max(0, cur.offsetDays + days)) });
  },
  demoReset: () => http('POST', '/demo/reset', {}),
  opsOverview: () => http('GET', '/ops/overview'),
  opsRunSweep: (force) => http('POST', '/ops/sweeps/run', { forceOutcome: force }),
  opsRequery: (sweepId) => http('POST', `/ops/sweeps/${sweepId}/requery`),
  opsResolveAlert: (alertId, decision) => http('POST', `/ops/alerts/${alertId}/resolve`, { decision }),
};

export const api: Api = live ? liveApi : mock;
export const isLive = live;
