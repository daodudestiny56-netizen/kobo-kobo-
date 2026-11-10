import type { Deps } from '../deps';
import { mapLimit } from '../util/async';
import { SmsSendError } from './provider';

const LEASE_MS = 5 * 60_000;

export interface DispatchResult {
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Send queued SMS. Safe to run on many instances at once: rows are claimed with FOR UPDATE SKIP LOCKED and leased for
 * five minutes (a crashed sender's rows become claimable again). Failures retry with exponential backoff until
 * `sms.maxAttempts`, then the row is marked FAILED and left for ops.
 */
export async function dispatchDueSms(deps: Deps, limit = 50): Promise<DispatchResult> {
  const now = deps.clock();
  const { rows } = await deps.db.query<{ id: string; to_phone: string; body: string; attempts: number }>(
    `UPDATE sms_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = $2
      WHERE id IN (
        SELECT id FROM sms_outbox
         WHERE status IN ('QUEUED','SENDING') AND next_attempt_at <= $1
         ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id, to_phone, body, attempts`,
    [now, new Date(now.getTime() + LEASE_MS), limit],
  );

  const out: DispatchResult = { sent: 0, retried: 0, failed: 0 };
  await mapLimit(rows, 5, async (m) => {
    try {
      const r = await deps.sms.send(m.to_phone, m.body);
      await deps.db.query(`UPDATE sms_outbox SET status = 'SENT', provider_message_id = $2, sent_at = $3, last_error = NULL WHERE id = $1`, [m.id, r.messageId, deps.clock()]);
      out.sent++;
    } catch (e) {
      const retryable = e instanceof SmsSendError ? e.retryable : true;
      const message = (e as Error).message;
      if (retryable && m.attempts < deps.config.sms.maxAttempts) {
        const delay = deps.config.sms.retryBaseMs * 2 ** (m.attempts - 1);
        await deps.db.query(`UPDATE sms_outbox SET status = 'QUEUED', next_attempt_at = $2, last_error = $3 WHERE id = $1`, [m.id, new Date(deps.clock().getTime() + delay), message]);
        out.retried++;
      } else {
        await deps.db.query(`UPDATE sms_outbox SET status = 'FAILED', last_error = $2 WHERE id = $1`, [m.id, message]);
        out.failed++;
      }
    }
  });
  return out;
}

export function startSmsDispatcher(deps: Deps): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatchDueSms(deps)
      .catch((e) => console.error('[sms] dispatch failed:', e))
      .finally(() => {
        running = false;
      });
  }, deps.config.sms.dispatchIntervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
