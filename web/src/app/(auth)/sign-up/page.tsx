'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Lock, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import type { DemoTrader, Lang, Merchant } from '@/lib/api/types';
import { naira } from '@/lib/money';
import { useSession } from '@/lib/session';
import { isElevenDigits, isPhone, normalisePhone, plainError } from '@/lib/text';
import { AuthFrame } from '@/components/AuthFrame';

const LANGS: { v: Lang; label: string }[] = [
  { v: 'en', label: 'English' },
  { v: 'pidgin', label: 'Pidgin' },
  { v: 'yoruba', label: 'Yoruba' },
  { v: 'hausa', label: 'Hausa' },
  { v: 'igbo', label: 'Igbo' },
];

const CONSENT =
  "I agree that Kobo Kobo may move my chosen share of each day's sales from my bank account into my Access ARM pension. I can pause, change or stop this at any time. I understand that pension returns are not guaranteed.";

const STEPS = ['Phone', 'Identity', 'Account', 'Your share', 'Agree'];

export default function SignUpPage() {
  const router = useRouter();
  const { signIn, demoMode } = useSession();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<Merchant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // step 0
  const [phone, setPhone] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  // step 1
  const [bvn, setBvn] = useState('');
  const [nin, setNin] = useState('');
  // step 2
  const [account, setAccount] = useState('');
  const [resolved, setResolved] = useState<{ name: string; tier: number } | null>(null);
  const [mine, setMine] = useState(false);
  // step 3
  const [rateBps, setRateBps] = useState(200);
  const [language, setLanguage] = useState<Lang>('pidgin');
  // step 4
  const [consent, setConsent] = useState(false);

  const [traders, setTraders] = useState<DemoTrader[]>([]);
  useEffect(() => {
    api.listDemoTraders().then(setTraders).catch(() => setTraders([]));
  }, []);

  function fill(t: DemoTrader) {
    setPhone(t.phone);
    setBvn(t.bvn);
    setNin(t.nin);
    setAccount(t.bankAccount);
    setLanguage(t.language);
    setResolved(null);
    setMine(false);
    setError('');
  }

  const back = () => {
    setError('');
    setStep((s) => Math.max(0, s - 1));
  };

  async function next() {
    setError('');
    if (step === 0) {
      const p = normalisePhone(phone);
      if (!isPhone(p)) return setError('Enter your Nigerian mobile number, for example 0803 123 4567.');
      setPhone(p);
      if (!codeSent) return setCodeSent(true);
      setBusy(true);
      try {
        await api.verifyOtp(p, code.trim());
        setStep(1);
      } catch (e) {
        setError(plainError(e));
      } finally {
        setBusy(false);
      }
    } else if (step === 1) {
      if (!isElevenDigits(bvn)) return setError('Your BVN is 11 digits. Dial *565*0# on the phone linked to your bank to get it.');
      if (!isElevenDigits(nin)) return setError('Your NIN is 11 digits. Check your NIN slip or the NIMC app.');
      setStep(2);
    } else if (step === 2) {
      if (!resolved) {
        if (!/^\d{10}$/.test(account)) return setError('A bank account number is 10 digits.');
        setBusy(true);
        try {
          setResolved(await api.resolveAccount(account));
        } catch (e) {
          setError(plainError(e));
        } finally {
          setBusy(false);
        }
        return;
      }
      if (!mine) return setError('Please confirm this is your account.');
      setStep(3);
    } else if (step === 3) {
      setStep(4);
    } else {
      if (!consent) return setError('Please agree to continue.');
      setBusy(true);
      try {
        const m = await api.onboard({ bankAccount: account, bvn, nin, phone, language, rateBps, consent });
        setDone(m);
      } catch (e) {
        const msg = plainError(e);
        setError(msg);
        // Identity problems belong on the identity step.
        if (/bvn|nin|identity/i.test(msg)) setStep(1);
      } finally {
        setBusy(false);
      }
    }
  }

  if (done) {
    return (
      <AuthFrame>
        <p className="item-icon brand" style={{ width: 56, height: 56 }}><Check size={28} aria-hidden /></p>
        <h1 className="h1 mt4">You are in, {done.fullName.split(' ')[0]}</h1>
        <p className="muted mt2">Your identity checked out and your account name matched. Your sales keep landing in your own account. We only move the share you chose, each night.</p>
        <ul className="facts mt5">
          <li><span className="k">Your account</span><span className="v">{done.bankAccount}</span></li>
          <li><span className="k">Pension fund manager</span><span className="v">Access ARM Pensions</span></li>
          <li><span className="k">Pension number (RSA PIN)</span><span className="v">{done.rsaPin}</span></li>
          <li><span className="k">Your share</span><span className="v">{rateBps / 100}% of daily sales</span></li>
        </ul>
        <button className="btn btn-primary btn-block mt5" onClick={() => { signIn(done.id); router.push('/home'); }}>Go to my pension</button>
      </AuthFrame>
    );
  }

  const titles = [
    codeSent ? 'Enter your code' : 'Your phone number',
    'Confirm who you are',
    'Link your bank account',
    'Choose your share',
    'Review and agree',
  ];

  return (
    <AuthFrame aside={{ text: 'Have an account?', href: '/sign-in', label: 'Sign in' }}>
      <ol className="steps" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
        {STEPS.map((s, i) => <li key={s} data-done={i <= step} />)}
      </ol>
      {step > 0 && (
        <button className="back mt3" onClick={back} type="button"><ArrowLeft size={18} aria-hidden /> Back</button>
      )}
      <h1 className="h1 mt4">{titles[step]}</h1>

      {step === 0 && (
        <div className="mt5">
          {!codeSent ? (
            <>
              <p className="muted">We use your number to text you receipts and to sign you in. It takes about 3 minutes to join. Have your BVN, NIN and bank account number ready.</p>
              <div className="field mt5">
                <label className="label" htmlFor="phone">Mobile number</label>
                <input id="phone" className={`input ${error ? 'is-invalid' : ''}`} inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="field">
              <p className="muted">We sent a 6-digit code to {phone}.</p>
              <label className="label mt3" htmlFor="code">6-digit code</label>
              <input id="code" className={`input ${error ? 'is-invalid' : ''}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              {demoMode && <p className="hint">Demo code: 123456</p>}
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="mt5">
          <p className="notice notice-brand"><ShieldCheck size={20} aria-hidden /><span>We only check your identity. This does not move any money or open any loan.</span></p>
          <div className="field mt5">
            <label className="label" htmlFor="bvn">BVN</label>
            <input id="bvn" className="input" inputMode="numeric" maxLength={11} value={bvn} onChange={(e) => setBvn(e.target.value.replace(/\D/g, ''))} aria-describedby="bvn-h" />
            <p id="bvn-h" className="hint">11 digits. Dial *565*0# on the phone linked to your bank.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor="nin">NIN</label>
            <input id="nin" className="input" inputMode="numeric" maxLength={11} value={nin} onChange={(e) => setNin(e.target.value.replace(/\D/g, ''))} aria-describedby="nin-h" />
            <p id="nin-h" className="hint">11 digits, from your NIN slip or the NIMC app.</p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt5">
          <p className="muted">This is the account your customers pay into. Your sales stay here. Nothing is taken until the nightly saving.</p>
          <div className="field mt5">
            <label className="label" htmlFor="acct">Account number</label>
            <input id="acct" className={`input ${error ? 'is-invalid' : ''}`} inputMode="numeric" maxLength={10} value={account} onChange={(e) => { setAccount(e.target.value.replace(/\D/g, '')); setResolved(null); setMine(false); }} />
          </div>
          {resolved && (
            <>
              <p className="notice notice-brand mt4"><Check size={20} aria-hidden /><span><span className="notice-title">{resolved.name}</span><br /><span className="small">Xtradot Bank · Tier {resolved.tier}</span></span></p>
              <label className="choice mt3">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
                <span className="choice-title">Yes, this is my account</span>
              </label>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="mt5">
          <p className="muted">Each night we move this share of that day&apos;s sales into your pension. If you sell nothing, we take nothing.</p>
          <div className="choices mt5" role="radiogroup" aria-label="Your share of daily sales">
            {[100, 200, 300, 400, 500].map((b) => (
              <label key={b} className="choice">
                <input type="radio" name="rate" checked={rateBps === b} onChange={() => setRateBps(b)} />
                <span>
                  <span className="choice-title">{b / 100}% of daily sales{b === 200 ? ' (our suggested start)' : ''}</span>
                  <br />
                  <span className="hint">On a {naira(3_000_000)} day, that is {naira(Math.floor((3_000_000 * b) / 10_000))}.</span>
                </span>
              </label>
            ))}
          </div>
          <div className="field mt5">
            <label className="label" htmlFor="lang">Language for messages</label>
            <select id="lang" className="select" value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
              {LANGS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
            </select>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="mt5">
          <ul className="facts">
            <li><span className="k">Name</span><span className="v">{resolved?.name}</span></li>
            <li><span className="k">Account</span><span className="v">{account}</span></li>
            <li><span className="k">Your share</span><span className="v">{rateBps / 100}% of daily sales</span></li>
            <li><span className="k">Half goes to</span><span className="v">Emergency pot, open after 3 months</span></li>
            <li><span className="k">Half goes to</span><span className="v">Retirement pot, locked until 50</span></li>
          </ul>
          <label className="choice mt5">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span className="small">{CONSENT}</span>
          </label>
        </div>
      )}

      {error && <p className="error-text mt4" role="alert">{error}</p>}

      <button className="btn btn-primary btn-block mt5" onClick={next} disabled={busy || (step === 0 && codeSent && code.length !== 6)}>
        {busy ? 'Checking...' : step === 0 && !codeSent ? 'Send code' : step === 2 && !resolved ? 'Check account' : step === 4 ? 'Start saving' : 'Continue'}
      </button>

      <p className="small muted mt4 row" style={{ alignItems: 'flex-start' }}>
        <Lock size={16} aria-hidden style={{ marginTop: 3, flexShrink: 0 }} />
        <span>Your details are protected under the Nigeria Data Protection Act 2023. We keep a scrambled copy of your BVN, not the number itself.</span>
      </p>

      {demoMode && traders.length > 0 && (
        <details className="demo-acc mt6">
          <summary>Use a demo account</summary>
          <div className="row wrap mt3">
            {traders.map((t) => (
              <button key={t.bankAccount} className="btn btn-secondary btn-sm"  onClick={() => { fill(t); setCodeSent(false); setCode(''); setStep(0); }}>
                {t.fullName.split(' ')[0]}
              </button>
            ))}
          </div>
        </details>
      )}
    </AuthFrame>
  );
}
