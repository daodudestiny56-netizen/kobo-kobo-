'use client';

import { useState } from 'react';
import { Volume2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Lang } from '@/lib/api/types';
import { balanceSms, voiceBalance } from '@/lib/messages';
import { plainError } from '@/lib/text';
import { useSession, useSummary } from '@/lib/session';
import { SettingsFrame } from '@/components/SettingsFrame';

const LANGS: { v: Lang; label: string }[] = [
  { v: 'en', label: 'English' },
  { v: 'pidgin', label: 'Pidgin' },
  { v: 'yoruba', label: 'Yoruba' },
  { v: 'hausa', label: 'Hausa' },
  { v: 'igbo', label: 'Igbo' },
];

export default function MessagesPage() {
  const { data: s } = useSummary();
  const { merchantId, bump } = useSession();
  const [error, setError] = useState('');

  if (!s) return <SettingsFrame title="Language and messages"><div className="skeleton" style={{ height: 240 }} aria-busy="true" /></SettingsFrame>;
  const lang = s.merchant.language;
  const translated = lang === 'yoruba' || lang === 'hausa' || lang === 'igbo';

  async function change(l: Lang) {
    if (!merchantId) return;
    try {
      await api.updateSettings(merchantId, { language: l });
      bump();
    } catch (e) {
      setError(plainError(e));
    }
  }

  function speak() {
    if (!s || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(voiceBalance(s, lang));
    u.lang = 'en-NG';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  return (
    <SettingsFrame title="Language and messages">
      <div className="field">
        <label className="label" htmlFor="lang">Language</label>
        <select id="lang" className="select" value={lang} onChange={(e) => change(e.target.value as Lang)}>
          {LANGS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
        </select>
        {translated && <p className="hint">Yoruba, Hausa and Igbo messages are not ready yet, so you will get English for now.</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>

      <h2 className="h2 mt6">How your messages will read</h2>
      <p className="panel mt3" style={{ background: 'var(--brand-tint)' }}>{balanceSms(s, lang)}</p>
      <button className="btn btn-secondary mt3" onClick={speak}><Volume2 size={18} aria-hidden /> Hear it read aloud</button>

      <h2 className="h2 mt6">When we message you</h2>
      <ul className="facts">
        <li><span className="k">Receipt after every saving</span><span className="v">Always on</span></li>
        <li><span className="k">If a saving fails or is held</span><span className="v">Always on</span></li>
      </ul>
      <p className="hint mt2">Pension rules require a receipt with a reference for every contribution, so these cannot be turned off.</p>
    </SettingsFrame>
  );
}
