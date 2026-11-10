import { emergencyStatusText } from '../sms/templates';
import type { Eligibility } from '../withdrawals/rules';

/**
 * Every USSD screen in English and Nigerian Pidgin. A screen must fit 182 characters (tests enforce it).
 * Yoruba, Hausa and Igbo fall back to English until the copy exists.
 * Functions return lines; the handler joins them and adds CON/END.
 */
export interface UssdCopy {
  menu(rate: string): string[];
  notRegistered: string[];
  invalidChoice: string[];
  oops: string[];
  balance(v: { total: string; emergency: string; eligibility: Eligibility; retirement: string }): string[];
  todayDone(v: { amount: string; ref: string }): string[];
  todayOpen(v: { takings: string; rate: string; projected: string; paused: boolean }): string[];
  ratePrompt(now: string): string[];
  rateInvalid: string[];
  rateDone(rate: string): string[];
  pauseOn: string[];
  pauseOff(until: string | null): string[];
  paused(until: string): string[];
  resumed: string[];
  withdrawUnavailable(status: string): string[];
  withdrawPrompt(pot: string): string[];
  withdrawInvalid: string[];
  withdrawTooMuch(pot: string): string[];
  withdrawConfirm(amount: string, account: string): string[];
  cancelled: string[];
  withdrawRejected: string[];
  withdrawOk(amount: string, account: string): string[];
  voiceQueued: string[];
  pinNotSet: string[];
  pinEnter: string[];
  pinWrong(left: number): string[];
  pinLocked(minutes: number): string[];
  pinCurrent: string[];
  pinNew: string[];
  pinConfirm: string[];
  pinMismatch: string[];
  pinWeak: string[];
  pinFormat: string[];
  pinUnchanged: string[];
  pinChanged: string[];
}

const en: UssdCopy = {
  menu: (rate) => [
    'Kobo Kobo',
    '1. Balance',
    "2. Today's Takings & Sweep",
    `3. Sweep Rate (Now: ${rate}%)`,
    '4. Pause / Resume Sweeps',
    '5. Emergency Withdrawal',
    '6. Spoken Balance (Call)',
    '7. Change PIN',
  ],
  notRegistered: ['This number is not registered on Kobo Kobo. Sign up in the app to start saving.'],
  invalidChoice: ['Invalid choice. Dial again to start over.'],
  oops: ['Sorry, something went wrong. Please try again shortly.'],
  balance: (v) => [
    'Kobo Kobo Balance',
    `Total: ${v.total}`,
    `Emergency: ${v.emergency} (${emergencyStatusText('en', v.eligibility, true)})`,
    `Retirement: ${v.retirement} (Locked to 50)`,
    '0. Back',
  ],
  todayDone: (v) => [`Tonight's sweep is done: ${v.amount} saved.`, `Ref ${v.ref}`],
  todayOpen: (v) => [
    `Takings so far: ${v.takings}`,
    ...(v.paused ? ['Sweeps are paused: nothing will be taken tonight.'] : [`Sweep tonight (${v.rate}%): ${v.projected}`, 'Sweeps run at 11pm.']),
  ],
  ratePrompt: (now) => ['Enter your new sweep rate, 1 to 5 (e.g. 2 or 2.5).', `Now: ${now}%`, '0. Back'],
  rateInvalid: ['Invalid rate. Use a number from 1 to 5. Dial again to retry.'],
  rateDone: (r) => [`Done! Your sweep rate is now ${r}%.`, 'It applies from the next nightly sweep.'],
  pauseOn: ['Sweeps are on.', '1. Pause for 48 hours', '0. Back'],
  pauseOff: (until) => [`Sweeps are paused${until ? ` until ${until}` : ''}.`, '1. Resume now', '0. Back'],
  paused: (until) => [`Sweeps paused until ${until}.`, 'Dial again to resume sooner.'],
  resumed: ['Sweeps resumed. Your next sweep runs at 11pm.'],
  withdrawUnavailable: (s) => [`Emergency cashout unavailable: ${s}.`],
  withdrawPrompt: (pot) => [`Emergency Pot: ${pot}`, 'Enter amount in naira to withdraw to your Access account:', '0. Back'],
  withdrawInvalid: ['Invalid amount. Dial again and enter naira, e.g. 1500.'],
  withdrawTooMuch: (pot) => [`You only have ${pot} in your Emergency Pot.`],
  withdrawConfirm: (amount, account) => [`Withdraw ${amount} to Access ${account}?`, '1. Yes', '2. No'],
  cancelled: ['Cancelled. No money was moved.'],
  withdrawRejected: ['The bank could not process this. Your money is safe in the Emergency Pot.'],
  withdrawOk: (amount, account) => [`${amount} is on its way to your Access account ${account}.`],
  voiceQueued: ['You will get a call shortly with your balance. Thank you for saving with Kobo Kobo.'],
  pinNotSet: ['Set your Kobo Kobo PIN in the app first. You need it to withdraw or change PIN.'],
  pinEnter: ['Enter your 4-digit PIN to confirm:'],
  pinWrong: (left) => [`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left. Nothing was withdrawn.`],
  pinLocked: (m) => [`PIN locked for ${m} minutes after too many wrong tries.`],
  pinCurrent: ['Enter your current 4-digit PIN:', '0. Back'],
  pinNew: ['Enter a new 4-digit PIN:', '0. Back'],
  pinConfirm: ['Enter the new PIN again:', '0. Back'],
  pinMismatch: ['The two PINs did not match. Dial again to retry.'],
  pinWeak: ['That PIN is too easy to guess. Avoid 1111, 1234 or your phone number. Dial again.'],
  pinFormat: ['A PIN is exactly 4 digits. Dial again to retry.'],
  pinUnchanged: ['New PIN must be different from the old one. Dial again.'],
  pinChanged: ['Your PIN has been changed. We sent you a text.'],
};

const pidgin: Partial<UssdCopy> = {
  menu: (rate) => [
    'Kobo Kobo',
    '1. Check Balance',
    '2. Today Sales & Sweep',
    `3. Change Sweep Rate (Now: ${rate}%)`,
    '4. Pause / Resume Sweep',
    '5. Emergency Money',
    '6. Hear Balance (Call me)',
    '7. Change PIN',
  ],
  notRegistered: ['This number no dey Kobo Kobo. Sign up for the app make you start to save.'],
  invalidChoice: ['That choice no correct. Dial again make you start over.'],
  oops: ['Sorry, wahala happen. Abeg try again small time.'],
  balance: (v) => [
    'Your Kobo Kobo Balance',
    `Total: ${v.total}`,
    `Emergency: ${v.emergency} (${emergencyStatusText('pidgin', v.eligibility, true)})`,
    `Retirement: ${v.retirement} (Lock till 50)`,
    '0. Back',
  ],
  todayDone: (v) => [`Tonight sweep don complete: ${v.amount} don save.`, `Ref ${v.ref}`],
  todayOpen: (v) => [
    `Sales so far: ${v.takings}`,
    ...(v.paused ? ['Sweep dey pause: we no go take anything tonight.'] : [`Sweep tonight (${v.rate}%): ${v.projected}`, 'Sweep dey run 11pm.']),
  ],
  ratePrompt: (now) => ['Put your new sweep rate, 1 to 5 (like 2 or 2.5).', `Now: ${now}%`, '0. Back'],
  rateInvalid: ['Rate no correct. Use number from 1 to 5. Dial again.'],
  rateDone: (r) => [`Correct! Your sweep rate na ${r}% now.`, 'E go start from next night sweep.'],
  pauseOn: ['Sweep dey run.', '1. Pause for 48 hours', '0. Back'],
  pauseOff: (until) => [`Sweep dey pause${until ? ` till ${until}` : ''}.`, '1. Continue now', '0. Back'],
  paused: (until) => [`We don pause your sweep till ${until}.`, 'Dial again if you wan continue early.'],
  resumed: ['Sweep don continue. Next one go run 11pm.'],
  withdrawUnavailable: (s) => [`You no fit collect Emergency money now: ${s}.`],
  withdrawPrompt: (pot) => [`Emergency Pot: ${pot}`, 'Put the naira wey you wan collect go your Access account:', '0. Back'],
  withdrawInvalid: ['Amount no correct. Dial again, put naira like 1500.'],
  withdrawTooMuch: (pot) => [`Na only ${pot} dey your Emergency Pot.`],
  withdrawConfirm: (amount, account) => [`Collect ${amount} go Access ${account}?`, '1. Yes', '2. No'],
  cancelled: ['We don cancel am. No money comot.'],
  withdrawRejected: ['Bank no gree process am. Your money dey safe for Emergency Pot.'],
  withdrawOk: (amount, account) => [`${amount} dey come your Access account ${account}.`],
  voiceQueued: ['We go call you soon to tell you your balance. Thank you for saving with Kobo Kobo.'],
  pinNotSet: ['Set your Kobo Kobo PIN for the app first. You go need am to collect money or change PIN.'],
  pinEnter: ['Put your 4-digit PIN to confirm:'],
  pinWrong: (left) => [`PIN no correct. ${left} ${left === 1 ? 'chance' : 'chances'} remain. Nothing comot.`],
  pinLocked: (m) => [`We don lock your PIN for ${m} minutes because you try wrong PIN too much.`],
  pinCurrent: ['Put your current 4-digit PIN:', '0. Back'],
  pinNew: ['Put new 4-digit PIN:', '0. Back'],
  pinConfirm: ['Put the new PIN again:', '0. Back'],
  pinMismatch: ['The two PIN no match. Dial again.'],
  pinWeak: ['That PIN too easy to guess. No use 1111, 1234 or your phone number. Dial again.'],
  pinFormat: ['PIN na exactly 4 digits. Dial again.'],
  pinUnchanged: ['New PIN must no be the same as the old one. Dial again.'],
  pinChanged: ['We don change your PIN. We send you text.'],
};

export function ussdCopy(lang: string): UssdCopy {
  return lang === 'pidgin' ? { ...en, ...pidgin } : en;
}
