import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Help' };

const FAQ = [
  { q: 'What is the nightly saving?', a: 'Each night we count your sales since the last saving, take your chosen share, and move it from your bank account into your pension. If you had no sales, nothing moves.' },
  { q: 'When does it happen?', a: 'Every night at 11:00 pm. Sales that arrive after 11:00 pm are counted the next night, so nothing is missed or counted twice.' },
  { q: 'Why can I not withdraw yet?', a: 'PenCom rules open the emergency pot 3 months after your first saving, and allow one withdrawal every 2 months after that. The retirement pot stays locked until you are 50.' },
  { q: 'Why was my saving skipped?', a: 'Open Activity and tap the night. We tell you why: no sales, saving was paused, or taking the share would have left your account below the safety minimum.' },
  { q: 'What does "held for a safety check" mean?', a: 'A payment far larger than usual arrived. We hold that one payment back until it is checked, in case it was sent by mistake. Your other sales are still counted.' },
  { q: 'Can I change how much I save?', a: 'Yes. Go to Settings, then Saving plan. You can pick 1% to 5%. The change starts tonight.' },
  { q: 'How do I stop?', a: 'Go to Settings, then Security and privacy, then Stop saving. Or text STOP. Your pension balance stays in your pension.' },
];

const COMMANDS = [
  ['BAL', 'Your balance and when the emergency pot opens'],
  ['PAUSE', 'Skip saving for 48 hours'],
  ['RESUME', 'Start saving again'],
  ['RATE 3', 'Change your share to 3% (any number from 1 to 5)'],
  ['STOP', 'Stop saving'],
  ['HELP', 'Send this list back to you'],
];

export default function HelpPage() {
  return (
    <div className="wide" style={{ paddingTop: 'var(--s6)', paddingBottom: 'var(--s8)', maxWidth: 820 }}>
      <h1 className="display">Help</h1>
      <p className="muted mt3" style={{ maxWidth: '54ch' }}>Plain answers about the nightly saving, your two pots and how to use Kobo Kobo on any phone.</p>

      <section className="mt7" aria-labelledby="faq-h">
        <h2 id="faq-h" className="h1">Common questions</h2>
        <div className="faq mt3">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="phone" className="mt7" aria-labelledby="phone-h">
        <h2 id="phone-h" className="h1">On a button phone</h2>
        <p className="muted mt2">
          Dial <b style={{ color: 'var(--ink)' }}>*384*5050#</b> for the menu, or send a text to the same number.
        </p>
        <ul className="facts mt4">
          {COMMANDS.map(([c, d]) => (
            <li key={c}><span className="v" style={{ textAlign: 'left' }}>{c}</span><span className="k" style={{ textAlign: 'right' }}>{d}</span></li>
          ))}
        </ul>
        <Link href="/demo/phone" className="btn btn-secondary mt5">Try the button phone</Link>
      </section>
    </div>
  );
}
