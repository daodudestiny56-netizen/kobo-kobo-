'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { api } from '@/lib/api';
import type { DemoTrader } from '@/lib/api/types';
import { useSession } from '@/lib/session';
import { isPhone, normalisePhone, plainError } from '@/lib/text';
import { AuthFrame } from '@/components/AuthFrame';

export default function SignInPage() {
  const router = useRouter();
  const { signIn, ready, merchantId, demoMode } = useSession();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [noAccount, setNoAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [traders, setTraders] = useState<DemoTrader[]>([]);

  useEffect(() => {
    if (ready && merchantId) router.replace('/home');
  }, [ready, merchantId, router]);

  useEffect(() => {
    api.listDemoTraders().then(setTraders).catch(() => setTraders([]));
  }, []);

  function sendCode(e: React.FormEvent) {
    e.preventDefault();
    const p = normalisePhone(phone);
    if (!isPhone(p)) {
      setError('Enter your Nigerian mobile number, for example 0803 123 4567.');
      return;
    }
    setPhone(p);
    setError('');
    setStep('code');
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNoAccount(false);
    try {
      const r = await api.verifyOtp(phone, code.trim());
      if (!r.merchantId) {
        setNoAccount(true);
        return;
      }
      signIn(r.merchantId);
      router.push('/home');
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  }

  async function demo(account: string) {
    setBusy(true);
    try {
      const m = await api.demoSignIn(account);
      signIn(m.id);
      router.push('/home');
    } catch (err) {
      setError(plainError(err));
      setBusy(false);
    }
  }

  return (
    <AuthFrame aside={{ text: 'New here?', href: '/sign-up', label: 'Start a pension' }}>
      <h1 className="h1">{step === 'phone' ? 'Welcome back' : 'Enter your code'}</h1>
      <p className="muted mt2">
        {step === 'phone' ? 'Sign in with your phone number. We will text you a code.' : `We sent a 6-digit code to ${phone}.`}
      </p>

      {step === 'phone' ? (
        <form onSubmit={sendCode} className="mt5" noValidate>
          <div className="field">
            <label className="label" htmlFor="phone">Mobile number</label>
            <input id="phone" className={`input ${error ? 'is-invalid' : ''}`} inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} aria-describedby={error ? 'phone-err' : undefined} />
            {error && <p id="phone-err" className="error-text" role="alert">{error}</p>}
          </div>
          <button className="btn btn-primary btn-block mt5" type="submit">Send code</button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt5" noValidate>
          <div className="field">
            <label className="label" htmlFor="code">6-digit code</label>
            <input id="code" className={`input ${error ? 'is-invalid' : ''}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-describedby="code-hint" />
            {demoMode && <p id="code-hint" className="hint">Demo code: 123456</p>}
            {error && <p className="error-text" role="alert">{error}</p>}
          </div>
          {noAccount && (
            <p className="notice notice-attn mt4" role="alert">
              <span>
                <span className="notice-title">No Kobo Kobo account for this number.</span>
                <br />
                <Link href="/sign-up" style={{ fontWeight: 700 }}>Start a pension</Link> with this number, or check the number you typed.
              </span>
            </p>
          )}
          <button className="btn btn-primary btn-block mt5" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking...' : 'Sign in'}</button>
          <button className="btn btn-text mt3" type="button" onClick={() => { setStep('phone'); setCode(''); setError(''); setNoAccount(false); }}>Use a different number</button>
        </form>
      )}

      <p className="small muted mt5 row" style={{ alignItems: 'flex-start' }}>
        <Lock size={16} aria-hidden style={{ marginTop: 3, flexShrink: 0 }} />
        <span>We never ask for your PIN or card details. Signing in does not move any money.</span>
      </p>

      {demoMode && traders.length > 0 && (
        <details className="demo-acc mt6">
          <summary>Use a demo account</summary>
          <div className="row wrap mt3">
            {traders.map((t) => (
              <button key={t.bankAccount} className="btn btn-secondary btn-sm" disabled={busy} onClick={() => demo(t.bankAccount)}>
                {t.fullName.split(' ')[0]}
              </button>
            ))}
          </div>
        </details>
      )}
    </AuthFrame>
  );
}
