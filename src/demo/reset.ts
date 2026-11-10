import { db } from "../db.js";
import { bank } from "../bank/index.js";
import { onboard, CONSENT_VERSION } from "../onboarding/service.js";
import { ensureWebhook } from "../webhooks/receiver.js";
import { setOffsetDays } from "./clock.js";

const TRADERS = [
  { phone: "+2348000000001", bankAccount: "0123456789", bvn: "22200000001", language: "igbo" },
  { phone: "+2348000000002", bankAccount: "0123456790", bvn: "22200000002", language: "yoruba" },
  { phone: "+2348000000003", bankAccount: "0123456791", bvn: "22200000003", language: "hausa" },
  { phone: "+2348000000004", bankAccount: "0123456792", bvn: "22200000004", language: "pidgin" },
];

const resetHooks: Array<() => void | Promise<void>> = [];
const seedHooks: Array<() => void | Promise<void>> = [];
export const onReset = (fn: () => void | Promise<void>) => { resetHooks.push(fn); };
export const onSeed = (fn: () => void | Promise<void>) => { seedHooks.push(fn); };

function wipe(): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migrat%'")
    .all() as { name: string }[];
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => { for (const t of tables) db.prepare(`DELETE FROM "${t.name}"`).run(); })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export async function seedDemo(): Promise<number> {
  let ok = 0;
  for (const t of TRADERS) {
    try {
      await onboard({ ...t, consentAccepted: true, consentVersion: CONSENT_VERSION });
      ok++;
    } catch (e) {
      console.warn("[demo] seed skipped", t.bankAccount, (e as { code?: string }).code ?? (e as Error).message);
    }
  }
  for (const h of seedHooks) await h();
  return ok;
}

export async function seedIfEmpty(): Promise<void> {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM merchants").get() as { n: number }).n;
  if (n === 0) console.log(`[demo] seeded ${await seedDemo()}/${TRADERS.length}`);
}

let busy = false;
export async function resetDemo(opts: { bank?: boolean } = {}): Promise<{ seeded: number }> {
  if (busy) throw new Error("RESET_IN_PROGRESS");
  busy = true;
  try {
    if (opts.bank) await bank.adminReset();
    wipe();
    for (const h of resetHooks) await h();
    setOffsetDays(0);
    const seeded = await seedDemo();
    await ensureWebhook();
    return { seeded };
  } finally {
    busy = false;
  }
}
