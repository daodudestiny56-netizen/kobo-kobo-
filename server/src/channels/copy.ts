import { emergencyStatusText } from '../messages/templates';
import type { Eligibility } from '../withdrawals/eligibility';

/**
 * Every USSD screen in English and Nigerian Pidgin (PRD 8.2). A screen fits 182 characters (tests enforce it).
 * Yoruba, Hausa and Igbo fall back to English until reviewed copy exists. Functions return lines; the handler
 * joins them and adds CON or END.
 */
export interface UssdCopy {
  menu(rate: string): string[];
  notRegistered: string[];
  cancelledPlan: string[];
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
  withdrawPrompt(pot: string): string[];
  withdrawInvalid: string[];
  withdrawConfirm(amount: string, account: string): string[];
  cancelled: string[];
  withdrawOk(amount: string, account: string): string[];
  spoken(v: { total: string; emergency: string; retirement: string; status: string }): string[];
}

const en: UssdCopy = {
  menu: (rate) => ['Kobo Kobo', '1 Balance', "2 Today and tonight's sweep", `3 Change rate (now ${rate}%)`, '4 Pause or resume', '5 Emergency cashout', '6 Spoken balance'],
  notRegistered: ['This number is not registered on Kobo Kobo. Sign up in the app to start saving.'],
  cancelledPlan: ['Your plan is cancelled. Your savings stay in your pension. Sign up again in the app to restart.'],
  invalidChoice: ['Invalid choice. Dial again to start over.'],
  oops: ['Sorry, something went wrong. Please try again shortly.'],
  balance: (v) => [
    'Kobo Kobo Balance',
    `Total: ${v.total}`,
    `Emergency: ${v.emergency} (${emergencyStatusText('en', v.eligibility, true)})`,
    `Retirement: ${v.retirement} (Locked to 50)`,
    '0 Back',
  ],
  todayDone: (v) => [`Tonight's sweep is done: ${v.amount} saved.`, `Ref ${v.ref}`],
  todayOpen: (v) => [
    `Takings so far: ${v.takings}`,
    ...(v.paused ? ['Sweeps are paused: nothing will be taken tonight.'] : [`Sweep tonight (${v.rate}%): ${v.projected}`, 'Sweeps run at 11pm.']),
  ],
  ratePrompt: (now) => ['Enter your new sweep rate, 1 to 5 (e.g. 2 or 2.5).', `Now: ${now}%`, '0 Back'],
  rateInvalid: ['Invalid rate. Use a number from 1 to 5. Dial again to retry.'],
  rateDone: (r) => [`Done! Your sweep rate is now ${r}%.`, 'It applies from the next nightly sweep.'],
  pauseOn: ['Sweeps are on.', '1 Pause for 48 hours', '0 Back'],
  pauseOff: (until) => [`Sweeps are paused${until ? ` until ${until}` : ''}.`, '1 Resume now', '0 Back'],
  paused: (until) => [`Sweeps paused until ${until}.`, 'Dial again to resume sooner.'],
  resumed: ['Sweeps resumed. Your next sweep runs at 11pm.'],
  withdrawPrompt: (pot) => [`Emergency Pot: ${pot}`, 'Enter the amount in naira to withdraw to your Access account:', '0 Back'],
  withdrawInvalid: ['Invalid amount. Dial again and enter naira, e.g. 1500.'],
  withdrawConfirm: (amount, account) => [`Withdraw ${amount} to Access ${account}?`, '1 Yes', '2 No'],
  cancelled: ['Cancelled. No money was moved.'],
  withdrawOk: (amount, account) => [`${amount} is on its way to your Access account ${account}.`],
  spoken: (v) => [`Your total savings are ${v.total}. Emergency Pot ${v.emergency}, ${v.status}. Retirement Pot ${v.retirement}, locked until age 50.`],
};

const pidgin: Partial<UssdCopy> = {
  menu: (rate) => ['Kobo Kobo', '1 Check balance', '2 Today sales and sweep', `3 Change rate (now ${rate}%)`, '4 Pause or continue', '5 Emergency money', '6 Hear balance'],
  notRegistered: ['This number no dey Kobo Kobo. Sign up for the app make you start to save.'],
  cancelledPlan: ['Your plan don cancel. Your savings dey safe for your pension. Sign up again for the app to start again.'],
  invalidChoice: ['That choice no correct. Dial again make you start over.'],
  oops: ['Sorry, wahala happen. Abeg try again small time.'],
  balance: (v) => [
    'Your Kobo Kobo Balance',
    `Total: ${v.total}`,
    `Emergency: ${v.emergency} (${emergencyStatusText('pidgin', v.eligibility, true)})`,
    `Retirement: ${v.retirement} (Lock till 50)`,
    '0 Back',
  ],
  todayDone: (v) => [`Tonight sweep don complete: ${v.amount} don save.`, `Ref ${v.ref}`],
  todayOpen: (v) => [
    `Sales so far: ${v.takings}`,
    ...(v.paused ? ['Sweep dey pause: we no go take anything tonight.'] : [`Sweep tonight (${v.rate}%): ${v.projected}`, 'Sweep dey run 11pm.']),
  ],
  ratePrompt: (now) => ['Put your new sweep rate, 1 to 5 (like 2 or 2.5).', `Now: ${now}%`, '0 Back'],
  rateInvalid: ['Rate no correct. Use number from 1 to 5. Dial again.'],
  rateDone: (r) => [`Correct! Your sweep rate na ${r}% now.`, 'E go start from next night sweep.'],
  pauseOn: ['Sweep dey run.', '1 Pause for 48 hours', '0 Back'],
  pauseOff: (until) => [`Sweep dey pause${until ? ` till ${until}` : ''}.`, '1 Continue now', '0 Back'],
  paused: (until) => [`We don pause your sweep till ${until}.`, 'Dial again if you wan continue early.'],
  resumed: ['Sweep don continue. Next one go run 11pm.'],
  withdrawPrompt: (pot) => [`Emergency Pot: ${pot}`, 'Put the naira wey you wan collect go your Access account:', '0 Back'],
  withdrawInvalid: ['Amount no correct. Dial again, put naira like 1500.'],
  withdrawConfirm: (amount, account) => [`Collect ${amount} go Access ${account}?`, '1 Yes', '2 No'],
  cancelled: ['We don cancel am. No money comot.'],
  withdrawOk: (amount, account) => [`${amount} dey come your Access account ${account}.`],
  spoken: (v) => [`Your total savings na ${v.total}. Emergency Pot ${v.emergency}, ${v.status}. Retirement Pot ${v.retirement}, e lock till you reach 50.`],
};

export function ussdCopy(lang: string): UssdCopy {
  return lang === 'pidgin' ? { ...en, ...pidgin } : en;
}
