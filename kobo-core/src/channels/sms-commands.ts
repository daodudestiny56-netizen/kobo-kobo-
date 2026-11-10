import type { Deps } from '../deps';
import { nairaDisplay, rateDisplay } from '../money';
import { getPensionSummary } from '../pension/summary';
import { AppError } from '../errors';
import { resolveGuardAlert } from '../sweeps/release';
import { respondToSuggestion } from '../smart-rate/service';
import { enqueueSms } from '../sms/outbox';
import { balanceReply, emergencyStatusText, helpReply, notRegisteredReply, pausedReply, rateSetReply, rateUsageReply, resumedReply, guardNoneReply, guardReleasedReply, guardRetryReply, suggestionAccepted, suggestionDeclined, suggestionNone, unknownReply } from '../sms/templates';
import { formatWatDay } from '../time';
import { findMerchantByPhone, parseRate, pauseSweeps, resumeSweeps, setSweepRate } from './actions';

/**
 * Two-way SMS: BAL, PAUSE (alias STOP), RESUME (alias START), RATE n, YES / NO (answer to a Smart Rate suggestion), OK (release a sweep held for a big payment), HELP.
 * Returns the reply text (the PRD's `{ reply }`) and, for registered traders, also queues it as an outgoing SMS.
 * Unregistered senders get the text in the HTTP response only: we never spend SMS on strangers.
 */
export async function handleInboundSms(deps: Deps, input: { from: string; text: string; messageId?: string }): Promise<{ reply: string; queued: boolean }> {
  const merchant = await findMerchantByPhone(deps.db, input.from);
  if (!merchant) return { reply: notRegisteredReply, queued: false };

  const lang = merchant.preferred_language;
  const [cmd = '', ...args] = input.text.trim().toUpperCase().split(/\s+/);
  let reply: string;

  switch (cmd) {
    case 'BAL':
    case 'BALANCE': {
      const s = await getPensionSummary(deps.db, merchant.id, deps.clock());
      reply = balanceReply(lang, {
        total: nairaDisplay(s.total),
        emergency: nairaDisplay(s.emergency),
        emergencyStatus: emergencyStatusText(lang, s.eligibility),
        retirement: nairaDisplay(s.retirement),
      });
      break;
    }
    case 'PAUSE':
    case 'STOP': {
      const until = await pauseSweeps(deps, merchant.id);
      reply = pausedReply(lang, { until: formatWatDay(until) });
      break;
    }
    case 'RESUME':
    case 'START':
      await resumeSweeps(deps.db, merchant.id);
      reply = resumedReply(lang);
      break;
    case 'RATE': {
      const h = parseRate(args.join(''));
      if (h === null) {
        reply = rateUsageReply(lang);
      } else {
        await setSweepRate(deps.db, merchant.id, h);
        reply = rateSetReply(lang, { rate: rateDisplay(h) });
      }
      break;
    }
    case 'YES':
    case 'NO': {
      const r = await respondToSuggestion(deps, { merchantId: merchant.id, decision: cmd === 'YES' ? 'ACCEPT' : 'DECLINE', via: 'SMS' });
      reply =
        r.outcome === 'NONE'
          ? suggestionNone(lang)
          : r.outcome === 'ACCEPTED'
            ? suggestionAccepted(lang, { rate: rateDisplay(r.rate) })
            : suggestionDeclined(lang, { rate: rateDisplay(r.rate) });
      break;
    }
    case 'OK': {
      // The trader vouches for a large payment that Sweep Guard held. Only ANOMALOUS_INFLOW holds can be released this way.
      const open = await deps.db.query<{ id: string }>(
        `SELECT a.id FROM sweep_guard_alerts a JOIN daily_sweeps s ON s.id = a.sweep_id
          WHERE a.merchant_id = $1 AND a.status = 'PENDING_REVIEW' AND a.alert_type = 'ANOMALOUS_INFLOW' AND s.status = 'HELD_GUARD'
          ORDER BY a.created_at DESC LIMIT 1`,
        [merchant.id],
      );
      if (!open.rows[0]) {
        reply = guardNoneReply(lang);
        break;
      }
      try {
        await resolveGuardAlert(deps, { alertId: open.rows[0].id, decision: 'RELEASE', resolvedBy: `merchant:${merchant.id}`, via: 'SMS', note: 'Trader replied OK by SMS' });
        reply = guardReleasedReply(lang);
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        reply = guardRetryReply(lang);
      }
      break;
    }
    case 'HELP':
      reply = helpReply(lang);
      break;
    default:
      reply = unknownReply(lang);
  }

  const queued = await enqueueSms(deps.db, {
    merchantId: merchant.id,
    to: merchant.phone_number,
    kind: 'COMMAND_REPLY',
    body: reply,
    // Telcos redeliver webhooks; the same inbound message id must not produce a second reply.
    dedupeKey: input.messageId ? `reply:${input.messageId}` : undefined,
    at: deps.clock(),
  });
  return { reply, queued };
}
