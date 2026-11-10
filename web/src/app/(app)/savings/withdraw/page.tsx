'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate, naira } from '@/lib/money';
import { plainError } from '@/lib/text';
import { useSession, useSummary } from '@/lib/session';

type Stage = 'amount' | 'review' | 'done';

export default function WithdrawPage() {
  const { data: s } = useSummary();
  const { merchantId, bump } = useSession();
  const [stage, setStage] = useState<Stage>('amount');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  if (!s) return <div className="page page-narrow" aria-busy="true"><div className="skeleton" style={{ height: 220 }} /></div>;

  const w = s.withdrawal;
  const kobo = Math.round(Number(amount.replace(/,/g, '')) * 100);

  const header = (
    <>
      <Link href="/savings" className="back"><ArrowLeft size={18} aria-hidden /> Savings</Link>
      <h1 className="h1 mt2">Withdraw from your emergency pot</h1>
    </>
  );

  if (!w.eligible && stage !== 'done') {
    return (
      <div className="page page-narrow">
        {header}
        <p className="notice notice-attn mt5" role="status">
          <Info size={20} aria-hidden />
          <span>
            <span className="notice-title">You cannot withdraw yet</span>
            <br />
            {w.reason}
          </span>
        </p>
        {w.availableFrom && <p className="mt4 muted">Come back on <b style={{ color: 'var(--ink)' }}>{fmtDate(w.availableFrom)}</b>. Until then your savings keep growing with each sale.</p>}
        <p className="mt4 muted">This waiting time is a pension rule set by PenCom. It keeps the money working for you.</p>
        <Link href="/home" className="btn btn-secondary mt5">Back to home</Link>
      </div>
    );
  }

  function review() {
    if (!kobo || kobo <= 0) return setError('Enter how much you want to take out.');
    if (kobo > w.maxKobo) return setError(`You can take out up to ${naira(w.maxKobo)}.`);
    setError('');
    setStage('review');
  }

  async function confirm() {
    if (!merchantId) return;
    setBusy(true);
    try {
      const r = await api.withdraw(merchantId, kobo);
      if (!r.ok) {
        setError(r.message);
        setStage('amount');
        return;
      }
      setResult(r.message);
      setStage('done');
      bump();
    } catch (e) {
      setError(plainError(e));
      setStage('amount');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'done') {
    return (
      <div className="page page-narrow">
        <p className="item-icon brand" style={{ width: 56, height: 56 }}><Check size={28} aria-hidden /></p>
        <h1 className="h1 mt4">Withdrawal sent</h1>
        <p className="mt2">{result}</p>
        <p className="muted mt2">You can make your next emergency withdrawal in 2 months.</p>
        <Link href="/home" className="btn btn-primary mt5">Back to home</Link>
      </div>
    );
  }

  if (stage === 'review') {
    return (
      <div className="page page-narrow">
        <button className="back" onClick={() => setStage('amount')}><ArrowLeft size={18} aria-hidden /> Change amount</button>
        <h1 className="h1 mt2">Check and confirm</h1>
        <p className="amount-xl mt5">{naira(kobo)}</p>
        <ul className="facts mt4">
          <li><span className="k">From</span><span className="v">Emergency pot</span></li>
          <li><span className="k">To</span><span className="v">Your account {s.merchant.bankAccount}</span></li>
          <li><span className="k">Fee</span><span className="v">{naira(0)}</span></li>
          <li><span className="k">Arrives</span><span className="v">Within 24 hours</span></li>
          <li><span className="k">Next withdrawal</span><span className="v">In 2 months</span></li>
        </ul>
        {error && <p className="error-text mt4" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block mt5" onClick={confirm} disabled={busy}>{busy ? 'Sending...' : `Withdraw ${naira(kobo)}`}</button>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      {header}
      <p className="muted mt2">Available now: <b style={{ color: 'var(--ink)' }}>{naira(w.maxKobo)}</b>. Money goes to your own account.</p>

      <div className="field mt5">
        <label className="label" htmlFor="amt">Amount</label>
        <div className={`input-affix ${error ? 'is-invalid' : ''}`}>
          <span className="affix" aria-hidden>₦</span>
          <input id="amt" className="input input-lg" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d]/g, '')); setError(''); }} aria-describedby={error ? 'amt-err' : undefined} />
        </div>
        {error && <p id="amt-err" className="error-text" role="alert">{error}</p>}
      </div>

      <div className="row wrap mt3">
        {[25, 50, 100].map((p) => (
          <button key={p} className="btn btn-secondary btn-sm" onClick={() => { setAmount(String(Math.floor((w.maxKobo * p) / 10000))); setError(''); }}>
            {p === 100 ? 'All of it' : `${p}%`}
          </button>
        ))}
      </div>

      <p className="notice mt5"><Info size={20} aria-hidden /><span className="small">You can withdraw from the emergency pot once every 2 months. The retirement pot stays locked until you are 50.</span></p>

      <button className="btn btn-primary btn-block mt5" onClick={review}>Review</button>
    </div>
  );
}
