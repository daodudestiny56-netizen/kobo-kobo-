import { randomUUID } from 'node:crypto';
import type { Db } from '../db';

export interface Message {
  id: string;
  merchantId: string | null;
  channel: 'SMS' | 'USSD' | 'APP';
  direction: 'IN' | 'OUT';
  kind: string | null;
  language: string | null;
  body: string;
  createdAt: string;
}

/**
 * Store a message the simulators will show. No telco exists in the sandbox, so "sending" means writing the row.
 * `dedupeKey` makes it safe to call twice for the same event (a retried settlement still sends one receipt).
 * Returns false when the message was already stored.
 */
export function addMessage(
  db: Db,
  m: { merchantId: string | null; channel?: 'SMS' | 'USSD' | 'APP'; direction?: 'IN' | 'OUT'; kind: string; language?: string | null; body: string; dedupeKey?: string; at: Date },
): boolean {
  const r = db
    .prepare(`INSERT OR IGNORE INTO messages (id, merchant_id, channel, direction, kind, language, body, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), m.merchantId, m.channel ?? 'SMS', m.direction ?? 'OUT', m.kind, m.language ?? null, m.body, m.dedupeKey ?? null, m.at.toISOString());
  return r.changes === 1;
}

export function listMessages(db: Db, merchantId: string, limit = 50): Message[] {
  const rows = db.prepare(`SELECT * FROM messages WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(merchantId, limit) as any[];
  return rows.map((r) => ({
    id: r.id, merchantId: r.merchant_id, channel: r.channel, direction: r.direction, kind: r.kind, language: r.language, body: r.body, createdAt: r.created_at,
  }));
}
