import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { bank } from "./bank/index.js";
import type { BankTransaction } from "./bank/types.js";

// Our own money movements are never sales. Sweep reversals ("KOBO-SWP-...-REV") match the prefix too.
const NOT_SALES = ["KOBO-SWP-", "KOBO-WD-", "SWP-", "WDR-"];

export function isSale(r: BankTransaction): boolean {
  return (
    r.type === "transfer" &&
    r.direction === "credit" &&
    r.status === "successful" &&
    !NOT_SALES.some((p) => r.reference.startsWith(p))
  );
}

export type PollResult = { scanned: number; inserted: number };

const shift = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function run(): Promise<PollResult> {
  // Prepared lazily: this module loads before migrate() runs.
  const merchants = db
    .prepare("SELECT id, bank_account FROM merchants WHERE status = 'ACTIVE'")
    .all() as { id: string; bank_account: string }[];
  if (!merchants.length) return { scanned: 0, inserted: 0 };
  const byAccount = new Map(merchants.map((m) => [m.bank_account, m.id]));

  // Overlap by 5 minutes; UNIQUE(bank_reference) makes re-reading harmless.
  const last = db.prepare("SELECT MAX(settled_at) AS t FROM inflows").get() as { t: string | null };
  const sinceIso = last.t ? shift(last.t, -5 * 60_000) : undefined;

  const rows = await bank.listTransactions({ sinceIso });
  const ins = db.prepare(
    `INSERT OR IGNORE INTO inflows
       (id, merchant_id, bank_reference, amount_kobo, channel, counted, counterparty, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let inserted = 0;
  db.transaction(() => {
    for (const r of rows) {
      const merchantId = byAccount.get(r.account);
      if (!merchantId || r.direction !== "credit" || r.type === "opening_balance") continue;
      const info = ins.run(
        randomUUID(), merchantId, r.reference, r.amountKobo,
        r.channel ?? "unknown", isSale(r) ? 1 : 0, r.counterparty, r.at
      );
      inserted += info.changes;
    }
  })();
  return { scanned: rows.length, inserted };
}

// Concurrent callers share one in-flight poll, so a sweep that calls pollOnce() always gets fresh data.
let inflight: Promise<PollResult> | null = null;
export function pollOnce(): Promise<PollResult> {
  return (inflight ??= run().finally(() => {
    inflight = null;
  }));
}

export function startCollector(everyMs = 30_000): () => void {
  const t = setInterval(() => {
    pollOnce().catch((e) => console.warn("[collector]", (e as Error).message));
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/**
 * Takings for a sweep window [startIso, endIso). Bounds must be UTC ISO strings WITHOUT milliseconds
 * (YYYY-MM-DDTHH:MM:SSZ): 23:00 WAT is 22:00Z. Held credits are excluded; dismissed ones count.
 */
export function takingsKobo(merchantId: string, startIso: string, endIso: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_kobo), 0) AS s FROM inflows
       WHERE merchant_id = ? AND counted = 1
         AND (hold_status IS NULL OR hold_status = 'DISMISSED')
         AND settled_at >= ? AND settled_at < ?`
    )
    .get(merchantId, startIso, endIso) as { s: number };
  return row.s;
}
