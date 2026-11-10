import { findMerchantByPhone } from '../channels/actions';
import type { Deps } from '../deps';
import { nairaDisplay } from '../money';
import { getPensionSummary } from '../pension/summary';
import { enqueueSms } from '../sms/outbox';
import { balanceReply, emergencyStatusText, voiceMissedPrefix } from '../sms/templates';
import { mapLimit } from '../util/async';
import { VoiceCallError } from './provider';
import { sayXml, spokenBalance, spokenNotRegistered, spokenSorry } from './script';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VoiceDispatchResult {
  placed: number;
  retried: number;
  failed: number;
}

/** Text the trader the balance they asked to hear, because the call never connected. Idempotent per request. */
async function failRequest(deps: Deps, id: string, merchantId: string, reason: string): Promise<void> {
  const upd = await deps.db.query(`UPDATE voice_callback_requests SET status = 'FAILED', last_error = $2, completed_at = $3 WHERE id = $1 AND status IN ('PENDING','CALLING')`, [id, reason, deps.clock()]);
  if (upd.rowCount === 0) return;
  try {
    const m = await deps.db.query('SELECT phone_number, preferred_language FROM merchants WHERE id = $1', [merchantId]);
    if (!m.rows[0]) return;
    const s = await getPensionSummary(deps.db, merchantId, deps.clock());
    const lang = m.rows[0].preferred_language;
    await enqueueSms(deps.db, {
      merchantId,
      to: m.rows[0].phone_number,
      kind: 'COMMAND_REPLY',
      dedupeKey: `voice-fallback:${id}`,
      at: deps.clock(),
      body: `${voiceMissedPrefix(lang)} ${balanceReply(lang, { total: nairaDisplay(s.total), emergency: nairaDisplay(s.emergency), emergencyStatus: emergencyStatusText(lang, s.eligibility), retirement: nairaDisplay(s.retirement) })}`,
    });
  } catch (e) {
    console.error(`[voice] fallback SMS for ${id} failed:`, (e as Error).message); // the request is already FAILED; ops can see it
  }
}

/** Put a request back in the queue with exponential backoff, or give up (and text the balance) after maxAttempts. */
async function retryOrFail(deps: Deps, id: string, merchantId: string, attempts: number, reason: string): Promise<'retried' | 'failed'> {
  if (attempts >= deps.config.voice.maxAttempts) {
    await failRequest(deps, id, merchantId, reason);
    return 'failed';
  }
  const delay = deps.config.voice.retryBaseMs * 2 ** (attempts - 1);
  await deps.db.query(`UPDATE voice_callback_requests SET status = 'PENDING', next_attempt_at = $2, last_error = $3 WHERE id = $1 AND status IN ('PENDING','CALLING')`, [id, new Date(deps.clock().getTime() + delay), reason]);
  return 'retried';
}

/**
 * Place due calls. Safe on many instances at once (SKIP LOCKED claim; the claim also sets the call timeout, so a crashed
 * dispatcher or an unanswered call comes due again). A request that used up its attempts is closed and the trader is texted.
 */
export async function dispatchDueCalls(deps: Deps, limit = 20): Promise<VoiceDispatchResult> {
  const now = deps.clock();
  const cfg = deps.config.voice;
  const out: VoiceDispatchResult = { placed: 0, retried: 0, failed: 0 };

  // Out of attempts and due (an unanswered last call): close it.
  const spent = await deps.db.query<{ id: string; merchant_id: string }>(
    `SELECT id, merchant_id FROM voice_callback_requests WHERE status IN ('PENDING','CALLING') AND next_attempt_at <= $1 AND attempts >= $2 LIMIT $3`,
    [now, cfg.maxAttempts, limit],
  );
  for (const r of spent.rows) {
    await failRequest(deps, r.id, r.merchant_id, 'no answer after all attempts');
    out.failed++;
  }

  const claimed = await deps.db.query<{ id: string; merchant_id: string; attempts: number; phone_number: string }>(
    `WITH due AS (
       SELECT id FROM voice_callback_requests
        WHERE status IN ('PENDING','CALLING') AND next_attempt_at <= $1 AND attempts < $2
        ORDER BY next_attempt_at LIMIT $4 FOR UPDATE SKIP LOCKED)
     UPDATE voice_callback_requests v SET status = 'CALLING', attempts = v.attempts + 1, next_attempt_at = $3
       FROM due, merchants m WHERE v.id = due.id AND m.id = v.merchant_id
     RETURNING v.id, v.merchant_id, v.attempts, m.phone_number`,
    [now, cfg.maxAttempts, new Date(now.getTime() + cfg.callTimeoutMs), limit],
  );

  await mapLimit(claimed.rows, 5, async (r) => {
    try {
      const { callId } = await deps.voice.placeCall(r.phone_number, { requestId: r.id });
      await deps.db.query(`UPDATE voice_callback_requests SET provider_call_id = $2, last_error = NULL WHERE id = $1`, [r.id, callId]);
      out.placed++;
    } catch (e) {
      const retryable = e instanceof VoiceCallError ? e.retryable : true;
      const reason = (e as Error).message;
      if (retryable) out[(await retryOrFail(deps, r.id, r.merchant_id, r.attempts, reason)) === 'retried' ? 'retried' : 'failed']++;
      else {
        await failRequest(deps, r.id, r.merchant_id, reason);
        out.failed++;
      }
    }
  });
  return out;
}

export function startVoiceDispatcher(deps: Deps): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatchDueCalls(deps)
      .catch((e) => console.error('[voice] dispatch failed:', e))
      .finally(() => {
        running = false;
      });
  }, deps.config.voice.dispatchIntervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

export interface VoiceWebhook {
  isActive?: string;
  direction?: string;
  callerNumber?: string;
  destinationNumber?: string;
  clientRequestId?: string;
  sessionId?: string;
  callSessionState?: string;
  durationInSeconds?: string;
}

/**
 * Africa's Talking calls this when a call is answered (isActive=1: reply with the XML to speak) and when it ends
 * (isActive=0: reply 204). Outbound calls we placed carry clientRequestId. A trader dialling in is recognised by caller number.
 */
export async function handleVoiceWebhook(deps: Deps, b: VoiceWebhook): Promise<{ xml: string } | { done: true }> {
  const requestId = b.clientRequestId && UUID.test(b.clientRequestId) ? b.clientRequestId : null;
  const req = requestId
    ? (await deps.db.query<{ id: string; merchant_id: string; status: string; attempts: number }>(`SELECT id, merchant_id, status, attempts FROM voice_callback_requests WHERE id = $1`, [requestId])).rows[0]
    : undefined;

  if (b.isActive !== '1') {
    // Call over. If we never got as far as speaking (no answer, busy), try again or fall back to a text.
    if (req && req.status === 'CALLING') await retryOrFail(deps, req.id, req.merchant_id, req.attempts, `call ended without being answered (${b.callSessionState ?? 'unknown'})`);
    else if (req && req.status === 'DONE') await deps.db.query(`UPDATE voice_callback_requests SET completed_at = $2 WHERE id = $1 AND completed_at IS NULL`, [req.id, deps.clock()]);
    return { done: true };
  }

  let merchantId: string | null = req?.merchant_id ?? null;
  if (!merchantId) {
    const caller = b.direction === 'Outbound' ? b.destinationNumber : b.callerNumber;
    const m = caller ? await findMerchantByPhone(deps.db, caller) : null;
    merchantId = m?.id ?? null;
  }
  if (!merchantId) return { xml: sayXml(spokenNotRegistered) };

  try {
    const m = await deps.db.query<{ full_name: string; preferred_language: string }>('SELECT full_name, preferred_language FROM merchants WHERE id = $1', [merchantId]);
    const s = await getPensionSummary(deps.db, merchantId, deps.clock());
    if (req && (req.status === 'CALLING' || req.status === 'PENDING')) {
      await deps.db.query(`UPDATE voice_callback_requests SET status = 'DONE', served_at = $2, last_error = NULL WHERE id = $1 AND status IN ('PENDING','CALLING')`, [req.id, deps.clock()]);
    }
    return { xml: sayXml(spokenBalance(m.rows[0].preferred_language, { name: m.rows[0].full_name, total: s.total, emergency: s.emergency, retirement: s.retirement, eligibility: s.eligibility })) };
  } catch (e) {
    console.error('[voice] could not build the balance script:', (e as Error).message);
    return { xml: sayXml(spokenSorry) };
  }
}
