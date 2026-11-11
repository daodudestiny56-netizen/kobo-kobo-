// One container, one public port. Starts the API (internal 8081) and the web app (internal 3000),
// then proxies: /api, /hooks and /healthz go to the API, everything else to the web app.
import { spawn } from 'node:child_process';
import http from 'node:http';

const PUBLIC_PORT = Number(process.env.PORT ?? 8080);
const API = { host: '127.0.0.1', port: 8081 };
const WEB = { host: '127.0.0.1', port: 3000 };

const run = (name, args, env) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => {
    console.error(`[entry] ${name} exited (${code}); stopping`);
    process.exit(code ?? 1);
  });
  return child;
};

run('api', ['--import', 'tsx', 'src/server.ts'], { PORT: String(API.port) });
run('web', ['web/server.js'], { PORT: String(WEB.port), HOSTNAME: WEB.host });

const toApi = (url) => url.startsWith('/api/') || url.startsWith('/hooks/') || url === '/healthz';

http
  .createServer((req, res) => {
    const target = toApi(req.url ?? '/') ? API : WEB;
    const headers = { ...req.headers, 'x-forwarded-for': [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ') };
    const up = http.request({ ...target, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: { code: 'BAD_GATEWAY', message: 'Service is starting, try again' } }));
    });
    req.pipe(up);
  })
  .listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`[entry] listening on ${PUBLIC_PORT}`));
