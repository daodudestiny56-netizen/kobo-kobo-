/**
 * SMS copy. Plain ASCII on purpose ("N" not the naira sign): GSM-7 keeps a message at 160 chars/segment, and many
 * feature phones cannot render the naira sign. English and Nigerian Pidgin are written; Yoruba, Hausa and Igbo
 * fall back to English until the copy is translated.
 */
import type { Eligibility } from '../withdrawals/eligibility';
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

export const lowBalanceSkipped = (lang: string, v: { buffer: string }): string =>
  pick<{ buffer: string }>(lang, {
    en: (x) => `Kobo Kobo: We skipped tonight's pension sweep so your account keeps at least ${x.buffer}. Your savings are safe.`,
    pidgin: (x) => `Kobo Kobo: We no take pension money tonight so your account go still get ${x.buffer}. Your savings dey safe.`,
  })(v);

export const creditHeld = (lang: string, v: { amount: string }): string =>
  pick<{ amount: string }>(lang, {
    en: (x) => `Kobo Kobo: A payment of ${x.amount} is on hold while we check it, so it was left out of tonight's sweep. The rest of your sales were swept normally.`,
    pidgin: (x) => `Kobo Kobo: We hold one payment of ${x.amount} to check am, so e no enter tonight sweep. The rest of your sales don enter normal.`,
  })(v);

export const sweepFailed = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Tonight's pension sweep did not go through. No money left your account and your savings are safe. We will try again tomorrow.`,
    pidgin: () => `Kobo Kobo: Tonight pension sweep no go through. No money comot your account and your savings dey safe. We go try again tomorrow.`,
  })({});

export const sweepReversed = (lang: string, v: { sweep: string; reference: string }): string =>
  pick<{ sweep: string; reference: string }>(lang, {
    en: (x) => `Kobo Kobo: The bank reversed your sweep of ${x.sweep} (Ref: ${x.reference}). The money is back in your account and your pots were corrected.`,
    pidgin: (x) => `Kobo Kobo: The bank don reverse your sweep of ${x.sweep} (Ref: ${x.reference}). The money don return to your account and we don correct your pots.`,
  })(v);

export const withdrawalPaid = (lang: string, v: { amount: string; account: string }): string =>
  pick<{ amount: string; account: string }>(lang, {
    en: (x) => `Kobo Kobo: ${x.amount} from your Emergency Pot has been paid to your Access account ${x.account}.`,
    pidgin: (x) => `Kobo Kobo: ${x.amount} from your Emergency Pot don enter your Access account ${x.account}.`,
  })(v);

export const withdrawalFailed = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Your emergency withdrawal did not go through. Your Emergency Pot was not charged. Please try again.`,
    pidgin: () => `Kobo Kobo: Your emergency withdrawal no go through. We no touch your Emergency Pot. Abeg try again.`,
  })({});

/** The one refusal sentence every channel uses (app, USSD, SMS), built from the single eligibility decision. */
export function withdrawalRefusal(lang: string, e: Eligibility, v: { pot?: string } = {}): string {
  const p = lang === 'pidgin';
  switch (e.reason) {
    case 'RETIREMENT_LOCKED':
      return p ? 'Retirement Pot dey locked till you reach 50 years. You no fit collect am now.' : 'Your Retirement Pot is locked until age 50. It cannot be withdrawn now.';
    case 'NOT_VESTED':
      return p ? `You no fit collect Emergency money yet. E go open ${formatWatDay(e.eligibleOn!)}.` : `Emergency withdrawals open ${formatWatDay(e.eligibleOn!)}, 3 months after your first saving.`;
    case 'COOLDOWN_ACTIVE':
      return p ? `You don collect recently. Next time na ${formatWatDay(e.eligibleOn!)}.` : `You can withdraw once every 2 months. Your next withdrawal is ${formatWatDay(e.eligibleOn!)}.`;
    case 'EMPTY':
      return p ? 'Your Emergency Pot dey empty.' : 'Your Emergency Pot is empty.';
    default:
      return p ? 'You never start saving yet. Emergency money go open 3 months after your first saving.' : 'You have not started saving yet. Emergency withdrawals open 3 months after your first saving.';
  }
}

export const amountTooHigh = (lang: string, v: { available: string }): string =>
  pick<{ available: string }>(lang, {
    en: (x) => `That is more than your Emergency Pot. You can withdraw up to ${x.available}.`,
    pidgin: (x) => `That one pass your Emergency Pot. You fit collect reach ${x.available}.`,
  })(v);

export const helpReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: BAL = balance, PAUSE = pause sweeps, RESUME = restart, RATE 3 = sweep 3%, CASHOUT 5000 = emergency money, STOP = cancel plan, HELP = this list.`,
    pidgin: () => `Kobo Kobo: BAL = balance, PAUSE = rest sweep, RESUME = continue, RATE 3 = sweep 3%, CASHOUT 5000 = emergency money, STOP = cancel plan, HELP = this list.`,
  })({});

export const cancelledReply = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: Your plan is cancelled. No more sweeps. Your savings stay safe in your pension.`,
    pidgin: () => `Kobo Kobo: Your plan don cancel. No more sweep. Your savings go remain for your pension.`,
  })({});

export const cashoutReply = (lang: string, v: { amount: string }): string =>
  pick<{ amount: string }>(lang, {
    en: (x) => `Kobo Kobo: Withdrawal of ${x.amount} accepted. We are sending it to your Access account.`,
    pidgin: (x) => `Kobo Kobo: We don accept your ${x.amount} withdrawal. We dey send am to your Access account.`,
  })(v);

export const cashoutUsage = (lang: string): string =>
  pick<Record<string, never>>(lang, {
    en: () => `Kobo Kobo: To withdraw from your Emergency Pot text CASHOUT and the amount, e.g. CASHOUT 5000.`,
    pidgin: () => `Kobo Kobo: To collect Emergency money, text CASHOUT and the amount, like CASHOUT 5000.`,
  })({});

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
