import type { Deps } from '../deps';
import { addMessage } from '../messages/service';
import * as T from '../messages/templates';
import { merchantSummary } from '../merchants/summary';
import { respondToSuggestion } from '../smart-rate/service';
import { cancelMerchant } from '../merchants/service';
import { nairaDisplay, parsePositiveNaira, rateDisplay } from '../money';
import { formatWatDay } from '../time';
import { requestWithdrawal } from '../withdrawals/service';
import { merchantByPhone, parseRateBps, pause, resume, setRate } from './actions';

/**
 * Two-way SMS (PRD 8.3): BAL, PAUSE, RESUME, RATE n, CASHOUT n, STOP (cancel the plan), HELP, and YES / NO for a
 * Smart Rate suggestion. Returns the reply (the PRD's `{ reply }`). Both the inbound text and the reply are stored
 * as messages so the SMS simulator can show the conversation. Unregistered senders get a reply but no stored message.
 */
export async function handleInboundSms(deps: Deps, input: { from: string; text: string; messageId?: string }): Promise<{ reply: string }> {
  const m = merchantByPhone(deps, input.from);
  if (!m) return { reply: T.notRegisteredReply };
  const now = deps.clock();
  const lang = m.language;
  addMessage(deps.db, { merchantId: m.id, direction: 'IN', kind: 'COMMAND', language: lang, body: input.text, dedupeKey: input.messageId ? `in:${input.messageId}` : undefined, at: now });

  const [cmd = '', ...args] = input.text.trim().toUpperCase().split(/\s+/);
  let reply: string;
  if (m.status === 'CANCELLED' && cmd !== 'HELP') {
    reply = T.cancelledReply(lang);
  } else {
    switch (cmd) {
      case 'BAL':
      case 'BALANCE': {
        const s = merchantSummary(deps, m.id);
        reply = T.balanceReply(lang, { total: nairaDisplay(s.pots.total), emergency: nairaDisplay(s.pots.emergency), emergencyStatus: T.emergencyStatusText(lang, s.eligibility), retirement: nairaDisplay(s.pots.retirement) });
        break;
      }
      case 'PAUSE': {
        const until = pause(deps, m.id).pausedUntil!;
        reply = T.pausedReply(lang, { until: formatWatDay(until) });
        break;
      }
      case 'RESUME':
      case 'START':
        resume(deps, m.id);
        reply = T.resumedReply(lang);
        break;
      case 'RATE': {
        const bps = parseRateBps(args.join(''));
        if (bps === null) reply = T.rateUsageReply(lang);
        else {
          setRate(deps, m.id, bps);
          reply = T.rateSetReply(lang, { rate: rateDisplay(BigInt(bps)) });
        }
        break;
      }
      case 'CASHOUT': {
        let amount;
        try {
          amount = parsePositiveNaira((args[0] ?? '').replace(/,/g, ''));
        } catch {
          reply = T.cashoutUsage(lang);
          break;
        }
        reply = (await requestWithdrawal(deps, m.id, amount)).message; // same refusal or acceptance text as USSD and the app
        break;
      }
      case 'STOP':
        cancelMerchant(deps.db, m.id, now);
        reply = T.cancelledReply(lang);
        break;
      case 'YES':
      case 'NO': {
        const r = respondToSuggestion(deps, { merchantId: m.id, decision: cmd === 'YES' ? 'ACCEPT' : 'DECLINE' });
        reply = r.outcome === 'NONE' ? T.suggestionNone(lang) : r.outcome === 'ACCEPTED' ? T.suggestionAccepted(lang, { rate: rateDisplay(BigInt(r.bps)) }) : T.suggestionDeclined(lang, { rate: rateDisplay(BigInt(r.bps)) });
        break;
      }
      case 'HELP':
        reply = T.helpReply(lang);
        break;
      default:
        reply = T.unknownReply(lang);
    }
  }
  addMessage(deps.db, { merchantId: m.id, kind: 'COMMAND_REPLY', language: lang, body: reply, dedupeKey: input.messageId ? `reply:${input.messageId}` : undefined, at: now });
  return { reply };
}
