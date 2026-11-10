import type { Kobo } from '../money';
import { emergencyStatusText } from '../sms/templates';
import type { Eligibility } from '../withdrawals/rules';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** "1084 naira, 50 kobo" spoken form (text-to-speech reads digits fine; "N" would be read as the letter). */
export function spokenNaira(k: Kobo): string {
  const whole = k / 100n;
  const kobo = k % 100n;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return kobo === 0n ? `${w} naira` : `${w} naira, ${kobo} kobo`;
}

export interface BalanceVars {
  name: string;
  total: Kobo;
  emergency: Kobo;
  retirement: Kobo;
  eligibility: Eligibility;
}

/** What the trader hears. English and Nigerian Pidgin; other languages fall back to English. */
export function spokenBalance(lang: string, v: BalanceVars): string {
  const first = v.name.trim().split(/\s+/)[0] || '';
  if (lang === 'pidgin') {
    return [
      `Hello ${first}. Na Kobo Kobo dey talk.`,
      `All your pension savings na ${spokenNaira(v.total)}.`,
      `Your Emergency Pot get ${spokenNaira(v.emergency)}. ${emergencyStatusText('pidgin', v.eligibility, true)}.`,
      `Your Retirement Pot get ${spokenNaira(v.retirement)}. Dem lock am till you reach fifty.`,
      `Thank you say you dey save with Kobo Kobo. Bye bye.`,
    ].join(' ');
  }
  return [
    `Hello ${first}. This is Kobo Kobo.`,
    `Your total pension savings are ${spokenNaira(v.total)}.`,
    `Your Emergency Pot has ${spokenNaira(v.emergency)}. ${emergencyStatusText('en', v.eligibility, true)}.`,
    `Your Retirement Pot has ${spokenNaira(v.retirement)}, locked until you are fifty.`,
    `Thank you for saving with Kobo Kobo. Goodbye.`,
  ].join(' ');
}

export const spokenNotRegistered = 'This number is not registered on Kobo Kobo. Please sign up in the app. Goodbye.';
export const spokenSorry = 'Sorry, we could not read your balance right now. Please try again later. Goodbye.';

/** Africa's Talking voice XML. `voice` follows the language where the telco has one. */
export function sayXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman" playBeep="false">${esc(text)}</Say></Response>`;
}
