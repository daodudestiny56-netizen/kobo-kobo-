import Link from 'next/link';
import { Clock, Lock, MessageSquareText, PhoneCall, ShieldCheck, Smartphone } from 'lucide-react';

const STEPS = [
  { t: 'Customers pay you as usual', d: 'Every naira lands in your own bank account first. We never take anything before it reaches you.' },
  { t: 'Each night, we move your share', d: 'You choose a share of the day’s sales, from 1% to 5%. We suggest starting at 2%.' },
  { t: 'It splits into two pots', d: 'Half goes to an emergency pot you can reach after 3 months. Half goes to a retirement pot, locked until you are 50.' },
  { t: 'You get a receipt', d: 'A text message with a reference number, every time. Check your balance on any phone.' },
];

const FAQ = [
  { q: 'Do you take my money before I get it?', a: 'No. All your sales land in your own account first. Later each night, we move your chosen share from your account into your pension.' },
  { q: 'What if I make no sales?', a: 'Then nothing is taken. You only save when you sell, so there are no failed payments and no bank charges for missing one.' },
  { q: 'Can I get my money out?', a: 'The emergency pot opens 3 months after your first saving, and you can then withdraw once every 2 months. The retirement pot is paid out from age 50. These are PenCom pension rules.' },
  { q: 'Can I stop?', a: 'Yes, at any time, on the app, by text or on a button phone. What you have already saved stays in your pension.' },
  { q: 'Do I need a smartphone?', a: 'No. You can check your balance, pause and change your share by USSD or text message on any phone.' },
  { q: 'Who holds my pension?', a: 'Your pension is held under PenCom rules with Access ARM Pensions, not by Kobo Kobo. Pension returns are not guaranteed.' },
];

export default function LandingPage() {
  return (
    <>
      <section className="wide hero-split" aria-labelledby="hero-h">
        <div className="stack gap5">
          <p className="eyebrow">A pension for people who trade every day</p>
          <h1 id="hero-h" className="display">Your pension grows when your sales do.</h1>
          <p style={{ fontSize: '1.1875rem', color: 'var(--ink-2)', maxWidth: '48ch' }}>
            A small share of every naira your customers pay you goes into your own pension, automatically. A good day saves more. A slow day saves less. No sales, nothing taken.
          </p>
          <div className="row wrap">
            <Link href="/sign-up" className="btn btn-primary">Start a pension</Link>
            <Link href="/sign-in" className="btn btn-secondary">Sign in</Link>
          </div>
        </div>
        <div className="hero-photo">
          <img src="/images/market-woman.jpg" width={960} height={640} alt="A trader standing at her stall of provisions in a Lagos market" />
        </div>
      </section>

      <section className="band band-pad" aria-labelledby="gap-h">
        <div className="wide">
          <div className="split">
            <div className="stack gap4">
              <p className="eyebrow">The gap</p>
              <h2 id="gap-h" className="h1">9 in 10 personal pension accounts have never received a naira.</h2>
              <p style={{ color: 'var(--ink-2)', maxWidth: '54ch' }}>
                People sign up. Then saving depends on remembering, and on having a good day. Fixed weekly payments bounce on slow days. Traders&apos; income is daily and uneven, so the pension never gets started.
              </p>
            </div>
            <div className="hero-photo" style={{ alignSelf: 'flex-start', maxWidth: 420 }}>
              <img src="/images/mile12-trader.jpg" width={960} height={1440} alt="A trader in an apron at her stall in Mile 12 market, Lagos" style={{ aspectRatio: '4 / 3', objectPosition: 'center 30%' }} />
            </div>
          </div>
          <div className="stat-row mt7">
            <div className="stat">
              <p className="amount-lg is-brand">91.4%</p>
              <p className="small">of 219,316 personal pension accounts have never been funded. PenCom, Q1 2026</p>
            </div>
            <div className="stat">
              <p className="amount-lg is-brand">42%</p>
              <p className="small">of informal businesses could not survive a month without income. Moniepoint, 2025</p>
            </div>
            <div className="stat">
              <p className="amount-lg is-brand">70%</p>
              <p className="small">take in under ₦50,000 a day, and it changes day to day. Moniepoint, 2025</p>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="wide band-pad" aria-labelledby="how-h">
        <div className="split">
          <div className="stack gap3">
            <p className="eyebrow">How it works</p>
            <h2 id="how-h" className="h1">Save from what comes in. Nothing to remember.</h2>
            <p className="muted" style={{ maxWidth: '44ch' }}>
              Saving by default works better than asking people to remember. So the share moves on its own, and you stay in control.
            </p>
          </div>
          <ol className="steps-list">
            {STEPS.map((s, i) => (
              <li key={s.t}>
                <span className="step-n" aria-hidden>{i + 1}</span>
                <span>
                  <span className="h2">{s.t}</span>
                  <br />
                  <span className="muted">{s.d}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="band band-pad" aria-labelledby="glance-h">
        <div className="wide stack gap5">
          <div className="stack gap2" style={{ maxWidth: 620 }}>
            <p className="eyebrow">Your money at a glance</p>
            <h2 id="glance-h" className="h1">See what came in, and what you kept.</h2>
            <p className="muted">Your balance, every customer payment and every night&apos;s saving in one place, with a receipt number for each.</p>
          </div>
          <div className="shots">
            <figure className="shot">
              <img src="/images/app-home.png" width={780} height={1688} alt="The Kobo Kobo home screen: pension balance, a growth chart, and Withdraw and Pause saving buttons" loading="lazy" />
              <figcaption>Your balance and how it grew</figcaption>
            </figure>
            <figure className="shot">
              <img src="/images/app-transactions.png" width={780} height={1688} alt="The Transactions screen: customer payments and nightly savings, with search and filters" loading="lazy" />
              <figcaption>Every payment and every saving</figcaption>
            </figure>
            <figure className="shot">
              <img src="/images/app-savings.png" width={780} height={1688} alt="The Savings screen: total saved, the emergency pot and the retirement pot" loading="lazy" />
              <figcaption>Two pots, with clear rules</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section id="pots" className="wide band-pad" aria-labelledby="pots-h">
        <div className="stack gap5">
          <div className="stack gap2" style={{ maxWidth: 620 }}>
            <p className="eyebrow">Two pots, one pension</p>
            <h2 id="pots-h" className="h1">Money for emergencies, and money for old age.</h2>
          </div>
          <div className="pots">
            <div className="pot pot-emergency">
              <p className="pot-label"><Clock size={18} aria-hidden /> Emergency pot</p>
              <p className="amount-lg">Half of each saving</p>
              <p style={{ color: 'var(--ink-2)' }}>Opens 3 months after your first saving. Then you can take money out once every 2 months, paid to your own account.</p>
            </div>
            <div className="pot pot-retirement">
              <p className="pot-label"><Lock size={18} aria-hidden /> Retirement pot</p>
              <p className="amount-lg">Half of each saving</p>
              <p style={{ color: 'var(--ink-2)' }}>Locked until you are 50. This is the part that makes it a pension.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="phones" className="wide band-pad" aria-labelledby="phones-h">
        <div className="split">
          <div className="stack gap3">
            <p className="eyebrow">On any phone</p>
            <h2 id="phones-h" className="h1">No smartphone? No problem.</h2>
            <p className="muted" style={{ maxWidth: '44ch' }}>Not every trader has a smartphone. Everything important works on a basic button phone too.</p>
            <div className="row wrap mt3">
              <Link href="/help#phone" className="btn btn-secondary">See the text commands</Link>
            </div>
          </div>
          <ul className="list">
            <li className="item"><span className="item-icon"><Smartphone size={20} aria-hidden /></span><span className="grow"><span className="item-title">USSD menu</span><br /><span className="item-sub">Balance, tonight&apos;s saving, pause and change your share, with no data needed.</span></span></li>
            <li className="item"><span className="item-icon"><MessageSquareText size={20} aria-hidden /></span><span className="grow"><span className="item-title">Text commands</span><br /><span className="item-sub">Send BAL, PAUSE or RATE 3 and get an answer straight back.</span></span></li>
            <li className="item"><span className="item-icon"><PhoneCall size={20} aria-hidden /></span><span className="grow"><span className="item-title">Spoken balance</span><br /><span className="item-sub">Hear your balance read out, in Pidgin or English. Yoruba, Hausa and Igbo are coming.</span></span></li>
          </ul>
        </div>
      </section>

      <section className="band band-pad" aria-labelledby="safe-h">
        <div className="wide split">
          <div className="stack gap3">
            <p className="eyebrow">Safe by design</p>
            <h2 id="safe-h" className="h1">Your money is yours until the share moves.</h2>
          </div>
          <ul className="stack gap4">
            {[
              ['Sales go to your account first', 'We move a share afterwards. We never take from a payment on its way to you.'],
              ['Large unusual payments are held', 'If a very big payment arrives, perhaps by mistake, we hold it back until it is checked.'],
              ['We never take twice', 'If a transfer is unclear, we check it. We do not send it again.'],
              ['A safety minimum stays in your account', 'We always leave you enough to restock.'],
            ].map(([t, d]) => (
              <li key={t} className="row-top">
                <ShieldCheck size={22} aria-hidden style={{ color: 'var(--brand)', flexShrink: 0, marginTop: 2 }} />
                <span><span className="h2">{t}</span><br /><span className="muted">{d}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="faq" className="wide band-pad" aria-labelledby="faq-h">
        <div className="split">
          <h2 id="faq-h" className="h1">Questions people ask</h2>
          <div className="faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="band-ink band-pad" aria-labelledby="cta-h">
        <div className="wide stack gap4" style={{ alignItems: 'flex-start' }}>
          <h2 id="cta-h" className="display" style={{ color: 'var(--white)' }}>Start with your next sale.</h2>
          <p style={{ color: 'var(--tint)', maxWidth: '48ch' }}>It takes about 3 minutes to join. Your sales stay in your own account, and you can stop any time.</p>
          <Link href="/sign-up" className="btn btn-light">Start a pension</Link>
        </div>
      </section>
    </>
  );
}
