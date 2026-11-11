'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Lock, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import type { Consent, DemoTrader, Lang, OnboardResult } from '@/lib/api/types';
import { onboardProblem, type OnboardField } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { displayName, firstName, isPhone, normalisePhone } from '@/lib/text';
import { AuthFrame } from '@/components/AuthFrame';

const LANGS: { v: Lang; label: string }[] = [
  { v: 'en', label: 'English' },
  { v: 'pidgin', label: 'Pidgin' },
  { v: 'yoruba', label: 'Yoruba' },
  { v: 'hausa', label: 'Hausa' },
  { v: 'igbo', label: 'Igbo' },
];

const STEPS = ['Your details', 'Review and agree'];

type FieldErrors = Partial<Record<OnboardField, string>>;

export default function SignUpPage() {
  const router = useRouter();
  const { signIn, demoMode } = useSession();
  const [step, setStep] = useState<0 | 1>(0);
  const [done, setDone] = useState<(OnboardResult & { bankAccount: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState('');
  const [bvn, setBvn] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [language, setLanguage] = useState<Lang>('pidgin');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<{ message: string; signIn?: boolean } | null>(null);

  const [consent, setConsent] = useState<Consent | null>(null);
  const [consentError, setConsentError] = useState(false);
  const [agreed, setAgreed] = useState(false);

  const [traders, setTraders] = useState<DemoTrader[]>([]);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  // After a failed step or submit, bring the problem into view: the first invalid field, otherwise the notice.
  useEffect(() => {
    if (!notice && Object.keys(fieldErrors).length === 0) return;
    const el = document.querySelector<HTMLElement>('[aria-invalid="true"]') ?? noticeRef.current;
    if (!el) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }, [notice, fieldErrors, step]);

  // The consent text and its version come from the server, so what the person agrees to is exactly what is recorded.
  const loadConsent = useCallback(() => {
    setConsentError(false);
    api.consent().then(setConsent).catch(() => setConsentError(true));
  }, []);

  useEffect(() => {
    loadConsent();
    api.listDemoTraders().then(setTraders).catch(() => setTraders([]));
  }, [loadConsent]);

  function fill(t: DemoTrader) {
    setPhone(t.phone);
    setBvn(t.bvn);
    setBankAccount(t.bankAccount);
    setLanguage(t.language);
    setFieldErrors({});
    setNotice(null);
    setStep(0);
  }

  function validateDetails(): boolean {
    const errs: FieldErrors = {};
    if (!isPhone(normalisePhone(phone))) errs.phone = 'Enter your Nigerian mobile number, for example 0803 123 4567.';
    if (!/^\d{11}$/.test(bvn)) errs.bvn = 'Your BVN is 11 digits. Dial *565*0# on the phone linked to your bank to get it.';
    if (!/^\d{10}$/.test(bankAccount)) errs.bankAccount = 'A bank account number is 10 digits.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function toReview() {
    setNotice(null);
    if (validateDetails()) setStep(1);
  }

  async function submit() {
    setNotice(null);
    if (!agreed) {
      setNotice({ message: 'Please agree to the terms to continue.' });
      return;
    }
    if (!consent) return;
    setBusy(true);
    try {
      const r = await api.onboard({
        phone: normalisePhone(phone),
        bankAccount,
        bvn,
        language,
        consentAccepted: true,
        consentVersion: consent.version,
      });
      setDone({ ...r, bankAccount });
    } catch (e) {
      const p = onboardProblem(e);
      setStep(p.step);
      setFieldErrors(p.field ? { [p.field]: p.message } : {});
      if (!p.field) setNotice({ message: p.message, signIn: p.signIn });
      if (p.reloadConsent) {
        setAgreed(false);
        loadConsent();
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthFrame>
        <p className="item-icon brand" style={{ width: 56, height: 56 }}><Check size={28} aria-hidden /></p>
        <h1 className="h1 mt4">You are in, {firstName(done.fullName)}</h1>
        <p className="muted mt2">Your BVN was verified and the name matched your account. Your sales keep landing in your own account. We only move your share, each night.</p>
        <ul className="facts mt5">
          <li><span className="k">Name</span><span className="v">{displayName(done.fullName)}</span></li>
          <li><span className="k">Your account</span><span className="v mono">{done.bankAccount}</span></li>
          {done.rsaPin && <li><span className="k">Pension number (RSA PIN)</span><span className="v mono">{done.rsaPin}</span></li>}
          <li><span className="k">Your share</span><span className="v">{done.rateBps / 100}% of daily sales</span></li>
        </ul>
        <p className="hint mt3">You can change your share any time in Settings, under Saving plan.</p>
        <button className="btn btn-primary btn-block mt5" onClick={() => { signIn(done.merchantId); router.push('/home'); }}>Go to my pension</button>
      </AuthFrame>
    );
  }

  const langLabel = LANGS.find((l) => l.v === language)?.label ?? language;

  const noticeEl = notice && (
    <p ref={noticeRef} tabIndex={-1} className="notice notice-attn mt4" role="alert">
      <TriangleAlert size={20} aria-hidden />
      <span>
        {notice.message}
        {notice.signIn && <> <Link href="/sign-in" style={{ fontWeight: 700 }}>Sign in</Link></>}
      </span>
    </p>
  );

  return (
    <AuthFrame aside={{ text: 'Have an account?', href: '/sign-in', label: 'Sign in' }}>
      <ol className="steps" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
        {STEPS.map((s, i) => <li key={s} data-done={i <= step} />)}
      </ol>
      {step === 1 && (
        <button className="back mt3" onClick={() => { setNotice(null); setStep(0); }} type="button"><ArrowLeft size={18} aria-hidden /> Back</button>
      )}
      <h1 className="h1 mt4">{step === 0 ? 'Open your pension' : 'Review and agree'}</h1>

      {step === 0 && noticeEl}

      {step === 0 && (
        <form className="mt5" onSubmit={(e) => { e.preventDefault(); toReview(); }} noValidate>
          <p className="muted">It takes about 2 minutes. Have your BVN and the number of the bank account your customers pay into ready.</p>

          <div className="field mt5">
            <label className="label" htmlFor="phone">Mobile number</label>
            <input id="phone" className={`input ${fieldErrors.phone ? 'is-invalid' : ''}`} inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} aria-describedby="phone-h" aria-invalid={!!fieldErrors.phone} />
            <p id="phone-h" className={fieldErrors.phone ? 'error-text' : 'hint'} role={fieldErrors.phone ? 'alert' : undefined}>{fieldErrors.phone ?? 'We text your receipts here.'}</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="bvn">BVN</label>
            <input id="bvn" className={`input ${fieldErrors.bvn ? 'is-invalid' : ''}`} inputMode="numeric" maxLength={11} value={bvn} onChange={(e) => setBvn(e.target.value.replace(/\D/g, ''))} aria-describedby="bvn-h" aria-invalid={!!fieldErrors.bvn} />
            <p id="bvn-h" className={fieldErrors.bvn ? 'error-text' : 'hint'} role={fieldErrors.bvn ? 'alert' : undefined}>{fieldErrors.bvn ?? '11 digits. Dial *565*0# on the phone linked to your bank.'}</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="acct">Bank account number</label>
            <input id="acct" className={`input ${fieldErrors.bankAccount ? 'is-invalid' : ''}`} inputMode="numeric" maxLength={10} value={bankAccount} onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, ''))} aria-describedby="acct-h" aria-invalid={!!fieldErrors.bankAccount} />
            <p id="acct-h" className={fieldErrors.bankAccount ? 'error-text' : 'hint'} role={fieldErrors.bankAccount ? 'alert' : undefined}>{fieldErrors.bankAccount ?? 'The account your customers pay into. It must be in your own name.'}</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="lang">Language for messages</label>
            <select id="lang" className="select" value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
              {LANGS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
            </select>
          </div>

          <button className="btn btn-primary btn-block mt5" type="submit">Continue</button>
        </form>
      )}

      {step === 1 && (
        <div className="mt5">
          <ul className="facts">
            <li><span className="k">Mobile number</span><span className="v">{normalisePhone(phone)}</span></li>
            <li><span className="k">BVN</span><span className="v mono">{'•'.repeat(8)}{bvn.slice(-3)}</span></li>
            <li><span className="k">Bank account</span><span className="v mono">{bankAccount}</span></li>
            <li><span className="k">Language</span><span className="v">{langLabel}</span></li>
            <li><span className="k">Your share</span><span className="v">2% of daily sales to start</span></li>
          </ul>

          <h2 className="h2 mt6">Terms</h2>
          {consent ? (
            <div className="panel mt3">
              <p className="small" style={{ color: 'var(--ink-2)' }}>{consent.text}</p>
            </div>
          ) : consentError ? (
            <p className="notice notice-attn mt3" role="alert">
              <TriangleAlert size={20} aria-hidden />
              <span>We could not load the terms. <button type="button" className="btn btn-text" onClick={loadConsent}>Try again</button></span>
            </p>
          ) : (
            <div className="skeleton mt3" style={{ height: 120 }} aria-busy="true" />
          )}

          <label className="choice mt4">
            <input type="checkbox" checked={agreed} onChange={(e) => { setAgreed(e.target.checked); setNotice(null); }} disabled={!consent} />
            <span className="small">I have read and agree to these terms.</span>
          </label>

          {step === 1 && noticeEl}
          <button className="btn btn-primary btn-block mt5" onClick={submit} disabled={busy || !consent}>{busy ? 'Opening your pension...' : 'Start saving'}</button>
        </div>
      )}

      <p className="small muted mt4 row" style={{ alignItems: 'flex-start' }}>
        <Lock size={16} aria-hidden style={{ marginTop: 3, flexShrink: 0 }} />
        <span>Your details are protected under the Nigeria Data Protection Act 2023. We keep a scrambled copy of your BVN, not the number itself.</span>
      </p>

      {demoMode && traders.length > 0 && (
        <details className="demo-acc mt6">
          <summary>Use a demo account</summary>
          <div className="row wrap mt3">
            {traders.map((t) => (
              <button key={t.bankAccount} className="btn btn-secondary btn-sm" type="button" onClick={() => fill(t)}>
                {t.fullName.split(' ')[0]}
              </button>
            ))}
          </div>
        </details>
      )}
    </AuthFrame>
  );
}
