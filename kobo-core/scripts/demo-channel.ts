import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config';

/**
 *   npm run demo:ussd -- <phone>          interactive USSD session (0 = back, 99 = home, empty line = quit)
 *   npm run demo:sms  -- <phone> <text>   one inbound SMS, prints the reply
 */
const config = loadConfig();
const base = process.env.CORE_URL ?? `http://localhost:${config.port}`;
const q = config.webhookToken ? `?token=${encodeURIComponent(config.webhookToken)}` : '';
const [mode, phone, ...rest] = process.argv.slice(2);

if (!phone || (mode !== 'ussd' && mode !== 'sms')) {
  console.error('Usage: demo-channel ussd <phone> | demo-channel sms <phone> <text>');
  process.exit(1);
}

const post = async (path: string, body: object) => {
  try {
    return await fetch(`${base}${path}${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    console.error(`Could not reach core at ${base}. Is "npm run dev" running?`, (e as Error).message);
    process.exit(1);
  }
};

if (mode === 'sms') {
  const res = await post('/api/v1/sms/inbound', { from: phone, text: rest.join(' ') });
  console.log((await res.json()).reply ?? (await res.text()));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const path: string[] = [];
  for (;;) {
    const res = await post('/api/v1/ussd', { sessionId: 'demo', serviceCode: '*384#', phoneNumber: phone, text: path.join('*') });
    const out = await res.text();
    const end = out.startsWith('END ');
    console.log(`\n${out.slice(4)}\n`);
    if (end) break;
    process.stdout.write('> ');
    const next = await lines.next();
    const answer = next.done ? '' : String(next.value).trim();
    if (!answer) break;
    path.push(answer);
  }
  rl.close();
}
