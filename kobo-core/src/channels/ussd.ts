import { AppError } from '../errors';
import type { Deps } from '../deps';
import { nairaDisplay, parsePositiveNaira, rateDisplay, rateToHundredths } from '../money';
import { getPensionSummary } from '../pension/summary';
import { formatWatDay } from '../time';
import { emergencyStatusText } from '../sms/templates';
import { ussdCopy, type UssdCopy } from './ussd-copy';
import { changePin, pinProblem, verifyPin } from '../security/pin';
import { maskNuban, requestEmergencyWithdrawal } from '../withdrawals/service';
import {
  findMerchantByPhone,
  isPausedNow,
  parseRate,
  pauseSweeps,
  resumeSweeps,
  setSweepRate,
  todaySummary,
  type ChannelMerchant,
} from './actions';

/**
 * USSD menu (`*384*5050#`) for Africa's Talking. AT sends the whole path so far in `text` ("5*1500*1"), so the
 * handler is stateless. Every reply is `CON ...` (menu continues) or `END ...` (session over) and fits one
 * 182-character USSD screen. `0` goes back one step, `99` returns to the main menu.
 */
const con = (...lines: string[]) => `CON ${lines.join('\n')}`;
const end = (...lines: string[]) => `END ${lines.join('\n')}`;

/** Apply back (0) and home (99) navigation to the raw path. */
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
  const merchant = await findMerchantByPhone(deps.db, input.phoneNumber);
  if (!merchant) return end(...ussdCopy('en').notRegistered); // unknown number: no language on file
  const t = ussdCopy(merchant.preferred_language);

  const path = resolvePath(input.text ?? '');
  const [choice, ...rest] = path;
  if (choice === undefined) return con(...t.menu(rateDisplay(rateToHundredths(merchant.sweep_percentage))));

  try {
    switch (choice) {
      case '1':
        return await balanceScreen(deps, merchant, t);
      case '2':
        return await todayScreen(deps, merchant, t);
      case '3':
        return await rateFlow(deps, merchant, rest, t);
      case '4':
        return await pauseFlow(deps, merchant, rest, t);
      case '5':
        return await withdrawFlow(deps, merchant, rest, t);
      case '6':
        return await voiceRequest(deps, merchant, t);
      case '7':
        return await changePinFlow(deps, merchant, rest, t);
      default:
        return end(...t.invalidChoice);
    }
  } catch (e) {
    if (e instanceof AppError && e.code === 'PIN_INVALID') return end(...t.pinWrong(Number(e.details?.attempts_remaining ?? 0)));
    if (e instanceof AppError && e.code === 'PIN_LOCKED') return end(...t.pinLocked(Number(e.details?.minutes ?? 0)));
    if (e instanceof AppError && e.status < 500) return end(e.message);
    console.error('[ussd] unhandled error', e);
    return end(...t.oops);
  }
}

async function balanceScreen(deps: Deps, m: ChannelMerchant, t: UssdCopy) {
  const s = await getPensionSummary(deps.db, m.id, deps.clock());
  return con(...t.balance({ total: nairaDisplay(s.total), emergency: nairaDisplay(s.emergency), eligibility: s.eligibility, retirement: nairaDisplay(s.retirement) }));
}

async function todayScreen(deps: Deps, m: ChannelMerchant, t: UssdCopy) {
  const r = await todaySummary(deps, m);
  if (r.record?.status === 'EXECUTED') return end(...t.todayDone({ amount: nairaDisplay(r.record.sweepAmount), ref: r.record.pensionReference! }));
  return end(
    ...t.todayOpen({
      takings: nairaDisplay(r.takings),
      rate: rateDisplay(rateToHundredths(m.sweep_percentage)),
      projected: nairaDisplay(r.projected),
      paused: isPausedNow(m, deps.clock()),
    }),
  );
}

async function rateFlow(deps: Deps, m: ChannelMerchant, rest: string[], t: UssdCopy) {
  if (rest.length === 0) return con(...t.ratePrompt(rateDisplay(rateToHundredths(m.sweep_percentage))));
  const h = parseRate(rest[rest.length - 1]);
  if (h === null) return end(...t.rateInvalid);
  await setSweepRate(deps.db, m.id, h);
  return end(...t.rateDone(rateDisplay(h)));
}

async function pauseFlow(deps: Deps, m: ChannelMerchant, rest: string[], t: UssdCopy) {
  const paused = isPausedNow(m, deps.clock());
  if (rest.length === 0) return paused ? con(...t.pauseOff(m.paused_until ? formatWatDay(m.paused_until) : null)) : con(...t.pauseOn);
  if (rest[0] !== '1') return end(...t.invalidChoice);
  if (paused) {
    await resumeSweeps(deps.db, m.id);
    return end(...t.resumed);
  }
  const until = await pauseSweeps(deps, m.id);
  return end(...t.paused(formatWatDay(until)));
}

async function withdrawFlow(deps: Deps, m: ChannelMerchant, rest: string[], t: UssdCopy) {
  const s = await getPensionSummary(deps.db, m.id, deps.clock());
  if (!s.eligibility.eligible) return end(...t.withdrawUnavailable(emergencyStatusText(m.preferred_language, s.eligibility, true)));

  if (!m.has_pin) return end(...t.pinNotSet);
  if (rest.length === 0) return con(...t.withdrawPrompt(nairaDisplay(s.emergency)));
  let amount;
  try {
    amount = parsePositiveNaira(rest[0].replace(/,/g, ''));
  } catch {
    return end(...t.withdrawInvalid);
  }
  if (amount > s.emergency) return end(...t.withdrawTooMuch(nairaDisplay(s.emergency)));

  if (rest.length === 1) return con(...t.withdrawConfirm(nairaDisplay(amount), maskNuban(m.access_nuban)));
  if (rest[1] !== '1') return end(...t.cancelled);

  if (rest.length === 2) return con(...t.pinEnter);
  await verifyPin(deps, m.id, rest[2]); // PIN_INVALID / PIN_LOCKED are turned into screens by the handler
  const w = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount });
  if (w.status === 'REJECTED') return end(...t.withdrawRejected);
  return end(...t.withdrawOk(nairaDisplay(amount), maskNuban(m.access_nuban)));
}

async function changePinFlow(deps: Deps, m: ChannelMerchant, rest: string[], t: UssdCopy) {
  if (!m.has_pin) return end(...t.pinNotSet);
  if (rest.length === 0) return con(...t.pinCurrent);
  const [oldPin, newPin, again] = rest;
  await verifyPin(deps, m.id, oldPin); // fail fast, before asking for the new one
  if (rest.length === 1) return con(...t.pinNew);
  const problem = pinProblem(newPin, m.phone_number);
  if (problem === 'FORMAT') return end(...t.pinFormat);
  if (problem === 'WEAK') return end(...t.pinWeak);
  if (oldPin === newPin) return end(...t.pinUnchanged);
  if (rest.length === 2) return con(...t.pinConfirm);
  if (newPin !== again) return end(...t.pinMismatch);
  await changePin(deps, m.id, oldPin, newPin);
  return end(...t.pinChanged);
}

async function voiceRequest(deps: Deps, m: ChannelMerchant, t: UssdCopy) {
  // One open request per trader (a unique index enforces it); tapping again while one is queued changes nothing.
  await deps.db.query(
    `INSERT INTO voice_callback_requests (merchant_id, language, created_at, next_attempt_at) VALUES ($1,$2,$3,$3)
     ON CONFLICT (merchant_id) WHERE status IN ('PENDING','CALLING') DO NOTHING`,
    [m.id, m.preferred_language, deps.clock()],
  );
  return end(...t.voiceQueued);
}
