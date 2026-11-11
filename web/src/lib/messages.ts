import type { Lang, Summary } from './api/types';
import { fmtDate, nairaPlain } from './money';

// English and Pidgin are hand-written. Yoruba, Hausa and Igbo will be GLM-generated and cached by the
// backend (PRD 8.4); until then they fall back to English here.
// Availability always comes from the single eligibility rule (PRD 6.5), never from copy.

function availability(s: Summary, lang: Lang): string {
  const w = s.withdrawal;
  const pidgin = lang === 'pidgin';
  if (w.eligible) {
    return pidgin
      ? `You fit comot ${nairaPlain(w.maxKobo)} from emergency pot now.`
      : `You can withdraw up to ${nairaPlain(w.maxKobo)} from the emergency pot now.`;
  }
  if (w.availableFrom) {
    return pidgin
      ? `You fit comot from emergency pot from ${fmtDate(w.availableFrom)}.`
      : `The emergency pot opens on ${fmtDate(w.availableFrom)}.`;
  }
  return pidgin ? 'Emergency pot never dey open yet.' : 'The emergency pot is not available yet.';
}

export function balanceSms(s: Summary, lang: Lang): string {
  const total = nairaPlain(s.emergencyKobo + s.retirementKobo);
  const e = nairaPlain(s.emergencyKobo);
  const r = nairaPlain(s.retirementKobo);
  if (lang === 'pidgin') {
    return `Kobo Kobo: Your total pension money na ${total}. Emergency pot: ${e}. Retirement pot: ${r} (locked till age 50). ${availability(s, lang)}`;
  }
  return `Kobo Kobo: Total saved ${total}. Emergency pot ${e}. Retirement pot ${r} (locked until age 50). ${availability(s, lang)}`;
}

export function voiceBalance(s: Summary, lang: Lang): string {
  const first = s.merchant.fullName.split(' ')[0];
  const total = nairaPlain(s.emergencyKobo + s.retirementKobo).replace('N', '') + ' naira';
  if (lang === 'pidgin') {
    return `${first}, your total pension money na ${total}. ${availability(s, lang)} Well done!`;
  }
  return `${first}, your total pension savings are ${total}. ${availability(s, lang)} Well done!`;
}

export function receiptSms(lang: Lang, sweepKobo: number, ref: string): string {
  return lang === 'pidgin'
    ? `Kobo Kobo: We don add ${nairaPlain(sweepKobo)} to your pension. Ref ${ref}.`
    : `Kobo Kobo: ${nairaPlain(sweepKobo)} added to your pension. Ref ${ref}.`;
}

export const SMS_HELP =
  'Kobo Kobo: BAL balance, PAUSE pause 48h, RESUME resume, RATE 3 set 3%, STOP cancel, HELP this message.';
