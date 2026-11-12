// One container, one public port. Starts the API (internal 8081) and the web app (internal 3000),
// then proxies: /api and /hooks go to the API, everything else to the web app. /healthz answers for both.
import { spawn } from 'node:child_process';
import http from 'node:http';

const PUBLIC_PORT = Number(process.env.PORT ?? 8080);
const API = { host: '127.0.0.1', port: 8081 };
const WEB = { host: '127.0.0.1', port: 3000 };
const UPSTREAM_TIMEOUT_MS = 120_000; // a sweep run can wait on the bank for a while
const STOP_GRACE_MS = 10_000;

const children = [];
let stopping = false;

// As PID 1 this process ignores SIGTERM unless it handles it, which would make every rollout wait for the kill.
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('[entry] stopping');
  server.close();
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), STOP_GRACE_MS).unref();
  const exited = children.map((c) => new Promise((resolve) => (c.exitCode !== null || c.signalCode ? resolve() : c.once('exit', resolve))));
  Promise.all(exited).then(() => process.exit(code));
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

const run = (name, args, env) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(child);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`[entry] ${name} exited (${code}); stopping`);
    stop(code ?? 1);
  });
};

// Ready only when both halves answer, so a dead web app can never sit behind a "healthy" pod.
const probe = (target, path) =>
  new Promise((resolve) => {
    const req = http.get({ ...target, path, timeout: 2000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });

async function health(res) {
  const [api, web] = await Promise.all([probe(API, '/healthz'), probe(WEB, '/manifest.webmanifest')]);
  res.writeHead(api && web ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: api && web, api, web }));
}

const toApi = (path) => path.startsWith('/api/') || path.startsWith('/hooks/');

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') return void health(res);

  const target = toApi(path) ? API : WEB;
  const headers = { ...req.headers, 'x-forwarded-for': [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ') };
  const up = http.request({ ...target, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.setTimeout(UPSTREAM_TIMEOUT_MS, () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: { code: 'BAD_GATEWAY', message: 'Service is starting, try again' } }));
  });
  res.on('close', () => {
    if (!res.writableFinished) up.destroy(); // the client went away: stop the upstream work too
  });
  req.pipe(up);
});

run('api', ['--import', 'tsx', 'src/server.ts'], { PORT: String(API.port) });
run('web', ['web/server.js'], { PORT: String(WEB.port), HOSTNAME: WEB.host });

server.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`[entry] listening on ${PUBLIC_PORT}`));
