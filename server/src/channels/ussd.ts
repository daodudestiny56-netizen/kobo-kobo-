import type { Deps } from '../deps';
import { AppError } from '../errors';
import { getSweep } from '../sweeps/engine';
import { merchantSummary } from '../merchants/summary';
import { nairaDisplay, parsePositiveNaira, rateDisplay } from '../money';
import { emergencyStatusText, withdrawalRefusal, amountTooHigh } from '../messages/templates';
import { formatWatDay, upcomingSweepDate } from '../time';
import { requestWithdrawal } from '../withdrawals/service';
import { isPaused } from '../merchants/service';
import { maskAccount, merchantByPhone, parseRateBps, pause, resume, setRate } from './actions';
import { ussdCopy } from './copy';

/**
 * USSD menu, dialled as *384*5050# on the on-screen simulator (PRD 8.2). The simulator sends the whole path so far
 * in `text` ("5*1500*1"), so the handler is stateless. Every reply is `CON ...` (continues) or `END ...` (over)
 * and fits one 182-character screen. `0` goes back one step, `99` returns to the main menu.
 */
const con = (...lines: string[]) => `CON ${lines.join('\n')}`;
const end = (...lines: string[]) => `END ${lines.join('\n')}`;

export function resolvePath(text: string): string[] {
  const out: string[] = [];
  for (const part of text === '' ? [] : text.split('*')) {
    if (part === '0') out.pop();
    else if (part === '99') out.length = 0;
    else out.push(part.trim());
  }
  return out;
}

export async function handleUssd(deps: Deps, input: { phoneNumber: string; text: string }): Promise<string> {
  const m = merchantByPhone(deps, input.phoneNumber);
  if (!m) return end(...ussdCopy('en').notRegistered);
  const t = ussdCopy(m.language);
  if (m.status === 'CANCELLED') return end(...t.cancelledPlan);

  const [choice, ...rest] = resolvePath(input.text ?? '');
  if (choice === undefined) return con(...t.menu(rateDisplay(BigInt(m.rateBps))));
  try {
    const s = merchantSummary(deps, m.id);
    switch (choice) {
      case '1':
        return con(...t.balance({ total: nairaDisplay(s.pots.total), emergency: nairaDisplay(s.pots.emergency), eligibility: s.eligibility, retirement: nairaDisplay(s.pots.retirement) }));
      case '2': {
        const done = getSweep(deps.db, m.id, upcomingSweepDate(deps.clock()));
        if (done?.status === 'SETTLED') return end(...t.todayDone({ amount: nairaDisplay(done.sweep), ref: done.pensionReference! }));
        return end(...t.todayOpen({ takings: nairaDisplay(s.takingsToday), rate: rateDisplay(BigInt(m.rateBps)), projected: nairaDisplay(s.estimatedSweep), paused: s.paused }));
      }
      case '3': {
        if (rest.length === 0) return con(...t.ratePrompt(rateDisplay(BigInt(m.rateBps))));
        const bps = parseRateBps(rest[rest.length - 1]);
        if (bps === null) return end(...t.rateInvalid);
        setRate(deps, m.id, bps);
        return end(...t.rateDone(rateDisplay(BigInt(bps))));
      }
      case '4': {
        const paused = isPaused(m, deps.clock());
        if (rest.length === 0) return paused ? con(...t.pauseOff(m.pausedUntil && m.pausedUntil.getUTCFullYear() < 9000 ? formatWatDay(m.pausedUntil) : null)) : con(...t.pauseOn);
        if (rest[0] !== '1') return end(...t.invalidChoice);
        if (paused) {
          resume(deps, m.id);
          return end(...t.resumed);
        }
        return end(...t.paused(formatWatDay(pause(deps, m.id).pausedUntil!)));
      }
      case '5': {
        // The one eligibility decision comes first, so the refusal is the same sentence as on SMS and in the app.
        if (!s.eligibility.eligible) return end(withdrawalRefusal(m.language, s.eligibility));
        if (rest.length === 0) return con(...t.withdrawPrompt(nairaDisplay(s.pots.emergency)));
        let amount;
        try {
          amount = parsePositiveNaira(rest[0].replace(/,/g, ''));
        } catch {
          return end(...t.withdrawInvalid);
        }
        if (amount > s.pots.emergency) return end(amountTooHigh(m.language, { available: nairaDisplay(s.pots.emergency) }));
        if (rest.length === 1) return con(...t.withdrawConfirm(nairaDisplay(amount), maskAccount(m.bankAccount)));
        if (rest[1] !== '1') return end(...t.cancelled);
        const r = await requestWithdrawal(deps, m.id, amount);
        return r.accepted ? end(...t.withdrawOk(nairaDisplay(amount), maskAccount(m.bankAccount))) : end(r.message);
      }
      case '6':
        // Spoken balance: the text is built from the same numbers; the simulator reads it aloud (PRD 8.4).
        return end(...t.spoken({ total: nairaDisplay(s.pots.total), emergency: nairaDisplay(s.pots.emergency), retirement: nairaDisplay(s.pots.retirement), status: emergencyStatusText(m.language, s.eligibility) }));
      default:
        return end(...t.invalidChoice);
    }
  } catch (e) {
    if (e instanceof AppError && e.status < 500) return end(e.message);
    console.error('[ussd] unhandled error', e);
    return end(...t.oops);
  }
}
