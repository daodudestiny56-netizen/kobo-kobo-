/**
 * SMS copy. Plain ASCII on purpose ("N" not the naira sign): GSM-7 keeps a message at 160 chars/segment, and many
 * feature phones cannot render the naira sign. English and Nigerian Pidgin are written; Yoruba, Hausa and Igbo
 * fall back to English until the copy is translated.
 */
import type { Eligibility } from '../withdrawals/rules';
import { formatWatDay } from '../time';

export type Lang = 'en' | 'pidgin' | 'yoruba' | 'hausa' | 'igbo';

type Copy<V> = { en: (v: V) => string; pidgin?: (v: V) => string };
function pick<V>(lang: string, copy: Copy<V>): (v: V) => string {
  return (lang === 'pidgin' && copy.pidgin) || copy.en;
}

export interface ReceiptVars {
  takings: string;
  rate: string;
  sweep: string;
  emergency: string;
  retirement: string;
  reference: string;
}

export const sweepReceipt = (lang: string, v: ReceiptVars): string =>
  pick<ReceiptVars>(lang, {
    en: (x) =>
      `Kobo Kobo: Today sales ${x.takings}. Sweep ${x.rate}% (${x.sweep}) sent to Access ARM Pension. Emergency Pot: +${x.emergency}. Retirement Pot: +${x.retirement}. Ref: ${x.reference}. Text PAUSE to pause.`,
    pidgin: (x) =>
      `Kobo Kobo: Today sales na ${x.takings}. We don save ${x.rate}% (${x.sweep}) for Access ARM Pension. Emergency Pot: +${x.emergency}. Retirement Pot: +${x.retirement}. Ref: ${x.reference}. Text PAUSE make we rest.`,
  })(v);

export const bufferSkipped = (lang: string, v: { buffer: string }): string =>
  pick<{ buffer: string }>(lang, {
    en: (x) => `Kobo Kobo: We skipped tonight's pension sweep so your account keeps at least ${x.buffer}. Your savings are safe.`,
    pidgin: (x) => `Kobo Kobo: We no take pension money tonight so your account go still get ${x.buffer}. Your savings dey safe.`,
  })(v);

export const guardHeld = (lang: string, v: { selfRelease: boolean } = { selfRelease: false }): string =>
  pick<{ selfRelease: boolean }>(lang, {
    en: (x) =>
      `Kobo Kobo: Tonight's pension sweep is on hold while we check a large payment. No money was moved.` +
      (x.selfRelease ? ` If this payment is really yours, reply OK to continue.` : ` Our team will contact you.`),
    pidgin: (x) =>
      `Kobo Kobo: We hold tonight pension sweep to check one big payment. No money comot.` +
      (x.selfRelease ? ` If the money na your own, reply OK make we continue.` : ` Our team go contact you.`),
  })(v);

export const withdrawalConfirmed = (lang: string, v: { amount: string; account: string }): string =>
  pick<{ amount: string; account: string }>(lang, {
    en: (x) => `Kobo Kobo: ${x.amount} from your Emergency Pot is on its way to your Access account ${x.account}.`,
    pidgin: (x) => `Kobo Kobo: ${x.amount} from your Emergency Pot dey come to your Access account ${x.account}.`,
  })(v);

// ---- two-way SMS command replies ----

export const balanceReply = (lang: string, v: { total: string; emergency: string; emergencyStatus: string; retirement: string }): string =>
  pick<typeof v>(lang, {
    en: (x) =>
      `Kobo Kobo: Total saved is ${x.total}. Emergency Pot: ${x.emergency} (${x.emergencyStatus}). Retirement Pot: ${x.retirement} (Locked till 50). Text PAUSE to stop tomorrow sweep.`,
    pidgin: (x) =>
      `Kobo Kobo: Your total savings na ${x.total}. Emergency Pot: ${x.emergency} (${x.emergencyStatus}). Retirement Pot: ${x.retirement} (Locked till 50). Text PAUSE make we skip tomorrow sweep.`,
  })(v);

export const pausedReply = (lang: string, v: { until: string }): string =>
  pick<typeof v>(lang, {
    en: (x) => `Kobo Kobo: Sweeps paused until ${x.until}. Text RESUME to restart sooner.`,
    pidgin: (x) => `Kobo Kobo: We don pause your sweep till ${x.until}. Text RESUME make e continue.`,
  })(v);

export const resumedReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Sweeps resumed. Your next sweep runs at 11pm.`,
    pidgin: () => `Kobo Kobo: Sweep don resume. Next one go run 11pm.`,
  })({});

export const rateSetReply = (lang: string, v: { rate: string }): string =>
  pick<typeof v>(lang, {
    en: (x) => `Kobo Kobo: Sweep rate is now ${x.rate}%. It applies from the next nightly sweep.`,
    pidgin: (x) => `Kobo Kobo: Your sweep rate na ${x.rate}% now. E go start from the next night sweep.`,
  })(v);

export const rateUsageReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: To change your rate text RATE and a number from 1 to 5, e.g. RATE 3.`,
    pidgin: () => `Kobo Kobo: To change your rate, text RATE and number from 1 to 5, like RATE 3.`,
  })({});

export const helpReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: BAL = balance, PAUSE = pause 48 hours, RESUME = restart, RATE 3 = sweep 3%, HELP = this list.`,
    pidgin: () => `Kobo Kobo: BAL = balance, PAUSE = pause 48 hours, RESUME = continue, RATE 3 = sweep 3%, HELP = this list.`,
  })({});

export const unknownReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Sorry, we did not understand that. Text HELP to see the commands.`,
    pidgin: () => `Kobo Kobo: Sorry, we no understand that one. Text HELP to see the commands.`,
  })({});

export const notRegisteredReply = `Kobo Kobo: This number is not registered. Sign up in the Kobo Kobo app to start saving.`;

/** Emergency Pot status in the trader's language. `short` is the USSD wording (tight on space). */
export function emergencyStatusText(lang: string, e: Eligibility, short = false): string {
  const p = lang === 'pidgin';
  if (e.eligible) return p ? (short ? 'You fit collect' : 'You fit collect am') : short ? 'Eligible' : 'Eligible for payout';
  switch (e.reason) {
    case 'NOT_VESTED':
      return `${p ? 'E go open' : 'Opens'} ${formatWatDay(e.eligibleOn!)}`;
    case 'COOLDOWN_ACTIVE':
      return `${p ? 'Next collect' : 'Next payout'} ${formatWatDay(e.eligibleOn!)}`;
    case 'EMPTY':
      return p ? 'E empty' : 'Empty';
    default:
      return p ? 'E open 3 months after you start' : 'Opens 3 months after first saving';
  }
}

// ---- security notices ----

export const pinSetNotice = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Your PIN is set. You need it for emergency withdrawals. Never share it with anyone.`,
    pidgin: () => `Kobo Kobo: Your PIN don set. You go need am to collect Emergency money. No tell anybody your PIN.`,
  })({});

export const pinChangedNotice = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Your PIN was changed. If this was not you, call us now.`,
    pidgin: () => `Kobo Kobo: Your PIN don change. If no be you do am, call us now now.`,
  })({});

export const pinLockedNotice = (lang: string, v: { minutes: number }): string =>
  pick<typeof v>(lang, {
    en: (x) => `Kobo Kobo: Wrong PIN too many times. Withdrawals are locked for ${x.minutes} minutes. If this was not you, call us.`,
    pidgin: (x) => `Kobo Kobo: Dem enter wrong PIN many times. We lock withdrawal for ${x.minutes} minutes. If no be you, call us.`,
  })(v);

// ---- Smart Rate (suggestions the trader must confirm) ----

export const rateSuggestion = (lang: string, v: { current: string; suggested: string }): string =>
  pick<typeof v>(lang, {
    en: (x) => `Kobo Kobo: Your sales have been steady. Raise your sweep from ${x.current}% to ${x.suggested}% to save more? Reply YES to accept or NO to keep ${x.current}%. Nothing changes unless you reply YES.`,
    pidgin: (x) => `Kobo Kobo: Your sales don dey steady. You wan raise your sweep from ${x.current}% to ${x.suggested}% make you save more? Reply YES if you gree or NO make e remain ${x.current}%. Nothing go change if you no reply YES.`,
  })(v);

export const suggestionAccepted = (lang: string, v: { rate: string }): string =>
  pick<typeof v>(lang, {
    en: (x) => `Kobo Kobo: Done. Your sweep rate is now ${x.rate}% from the next nightly sweep. Text RATE 2 anytime to change it.`,
    pidgin: (x) => `Kobo Kobo: E don do. Your sweep rate na ${x.rate}% from the next night sweep. Text RATE 2 anytime if you wan change am.`,
  })(v);

export const suggestionDeclined = (lang: string, v: { rate: string }): string =>
  pick<typeof v>(lang, {
    en: (x) => `Kobo Kobo: No problem. Your sweep rate stays at ${x.rate}%.`,
    pidgin: (x) => `Kobo Kobo: No wahala. Your sweep rate go remain ${x.rate}%.`,
  })(v);

export const suggestionNone = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: There is no rate suggestion waiting for you. Text HELP for commands.`,
    pidgin: () => `Kobo Kobo: No rate suggestion dey wait for you. Text HELP to see commands.`,
  })({});

// ---- Sweep Guard resolution ----

export const guardReleasedReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Thank you. We are releasing your held sweep now. You will get a receipt shortly.`,
    pidgin: () => `Kobo Kobo: Thank you. We dey release your held sweep now. Receipt go reach you soon.`,
  })({});

export const guardNoneReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Nothing is waiting for your OK. Text HELP for commands.`,
    pidgin: () => `Kobo Kobo: Nothing no dey wait for your OK. Text HELP to see commands.`,
  })({});

export const guardBlockedNotice = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: After review we did not sweep that payment into your pension. Your savings are safe. Call us if you have questions.`,
    pidgin: () => `Kobo Kobo: After we check am, we no take that money enter your pension. Your savings dey safe. Call us if you get question.`,
  })({});

export const guardReleasedNotice = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Our team cleared your held sweep. It is being processed and you will get a receipt.`,
    pidgin: () => `Kobo Kobo: Our team don clear your held sweep. We dey process am, receipt go reach you.`,
  })({});

export const guardRetryReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: We could not release your held sweep right now. Our team will follow up with you.`,
    pidgin: () => `Kobo Kobo: We no fit release your held sweep now. Our team go follow up with you.`,
  })({});

export const voiceMissedPrefix = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `We tried to call you but could not reach you.`,
    pidgin: () => `We try call you but we no reach you.`,
  })({});
