'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Merchant } from '@/lib/api/types';
import { useSession } from '@/lib/session';
import { plainError } from '@/lib/text';

const DIAL = '*384*5050#';
type Line = { from: 'me' | 'sys'; text: string };

// An on-screen feature phone. It calls the same USSD and SMS endpoints a telco would (PRD 8.2 and 8.3). Simulated: no telco.
export default function PhonePage() {
  const { merchantId, version } = useSession();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [phone, setPhone] = useState('');
  const [screen, setScreen] = useState(`Press Dial to start ${DIAL}`);
  const [entry, setEntry] = useState('');
  const [path, setPath] = useState('');
  const [active, setActive] = useState(false);
  const session = useRef('');
  const [thread, setThread] = useState<Line[]>([]);
  const [sms, setSms] = useState('');

  useEffect(() => {
    api.listMerchants().then((ms) => {
      setMerchants(ms);
      const mine = ms.find((m) => m.id === merchantId);
      setPhone((p) => p || mine?.phone || ms[0]?.phone || '');
    });
  }, [merchantId, version]);

  async function dial() {
    if (!phone) return;
    session.current = `s_${Date.now()}`;
    setPath('');
    setEntry('');
    try {
      const r = await api.ussd(phone, session.current, '');
      setScreen(r.body);
      setActive(r.type === 'CON');
    } catch (e) {
      setScreen(plainError(e));
    }
  }

  async function send() {
    if (!active || !entry) return;
    const next = path ? `${path}*${entry}` : entry;
    try {
      const r = await api.ussd(phone, session.current, next);
      setPath(next);
      setEntry('');
      setScreen(r.body);
      setActive(r.type === 'CON');
    } catch (e) {
      setScreen(plainError(e));
      setActive(false);
    }
  }

  function end() {
    setActive(false);
    setPath('');
    setEntry('');
    setScreen(`Session ended. Press Dial to start ${DIAL}`);
  }

  async function sendSms(body: string) {
    if (!body.trim() || !phone) return;
    setThread((t) => [...t, { from: 'me', text: body }]);
    setSms('');
    try {
      const r = await api.sms(phone, body);
      setThread((t) => [...t, { from: 'sys', text: r.reply }]);
    } catch (e) {
      setThread((t) => [...t, { from: 'sys', text: plainError(e) }]);
    }
  }

  const digit = (k: string) => active && setEntry((e) => e + k);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Button phone</h1>
          <p className="muted mt2">The same account on a basic phone: USSD menu and text commands.</p>
        </div>
      </div>

      <div className="field" style={{ maxWidth: 360 }}>
        <label className="label" htmlFor="who">Phone number</label>
        <select id="who" className="select" value={phone} onChange={(e) => { setPhone(e.target.value); end(); }}>
          {merchants.length === 0 && <option value="">No one has joined yet</option>}
          {merchants.map((m) => <option key={m.id} value={m.phone}>{m.fullName.split(' ')[0]} · {m.phone}</option>)}
        </select>
      </div>

      <div className="cols mt6">
        <div className="col-main" style={{ flex: '0 0 auto' }}>
          <div className="handset" role="group" aria-label="Button phone">
            <div className="handset-screen" aria-live="polite">{screen}</div>
            <div className="handset-entry" aria-label="What you have typed">{active ? `> ${entry}` : ' '}</div>
            <div className="keys">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
                <button key={k} className="key" onClick={() => digit(k)} aria-label={`Key ${k}`}>{k}</button>
              ))}
              <button className="key" onClick={() => setEntry((e) => e.slice(0, -1))} aria-label="Delete last digit">Del</button>
              <button className="key" onClick={() => digit('0')} aria-label="Key 0">0</button>
              <button className="key" onClick={() => setEntry('')} aria-label="Clear">Clr</button>
              <button className="key key-call" onClick={active ? send : dial}>{active ? 'Send' : 'Dial'}</button>
              <button className="key key-end" onClick={end}>End</button>
            </div>
          </div>
        </div>

        <div className="col-main">
          <div className="panel">
            <h2 className="h2">Text messages</h2>
            <div className="thread" aria-live="polite">
              {thread.length === 0 && <p className="muted">Send BAL, PAUSE, RESUME, RATE 3, STOP or HELP.</p>}
              {thread.map((l, i) => <p key={i} className={`bubble ${l.from === 'me' ? 'bubble-me' : 'bubble-sys'}`}>{l.text}</p>)}
            </div>
            <div className="row wrap">
              {['BAL', 'PAUSE', 'RESUME', 'RATE 3', 'HELP'].map((c) => (
                <button key={c} className="btn btn-secondary btn-sm" onClick={() => sendSms(c)}>{c}</button>
              ))}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); sendSms(sms); }}>
              <label className="sr-only" htmlFor="sms">Type a command</label>
              <input id="sms" className="input grow" placeholder="Type a command" value={sms} onChange={(e) => setSms(e.target.value)} />
              <button className="btn btn-dark" type="submit">Send</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
