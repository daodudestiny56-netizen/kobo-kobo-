import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { bank } from "../bank/index.js";
import { BankError } from "../bank/types.js";
import { matchNames } from "./namematch.js";
import { idHash } from "./hash.js";

export const CONSENT_VERSION = "2026-11-v1";
export const CONSENT_TEXT =
  "I agree that Kobo Kobo may move a percentage of my daily takings (starting at 2%; I can choose 1% to 5%) " +
  "from my own bank account into my pension each night, split 50/50 between an emergency pot and a retirement pot. " +
  "Nothing is taken on days with no sales. The emergency pot can be withdrawn from 3 months after my first " +
  "contribution, then once every 2 months. The retirement pot is locked until age 50. I can pause, change or stop " +
  "at any time. Returns are not guaranteed and may be negative. This is a sandbox demo with simulated components.";

export class OnboardError extends Error {
  constructor(public code: string, public status: number, message: string, public field?: string) {
    super(message);
  }
}

type Hook = (merchantId: string) => void;
const hooks: Hook[] = [];
export const onOnboard = (fn: Hook) => { hooks.push(fn); };

const LANGS = ["en", "pidgin", "yoruba", "hausa", "igbo"];

export type OnboardInput = {
  phone?: string; bankAccount?: string; bvn?: string; language?: string;
  consentAccepted?: boolean; consentVersion?: string;
};

export async function onboard(b: OnboardInput) {
  const phone = String(b.phone ?? "").replace(/[\s-]/g, "");
  if (!/^\+?\d{10,15}$/.test(phone)) throw new OnboardError("INVALID_REQUEST", 400, "phone must be 10 to 15 digits", "phone");
  const account = String(b.bankAccount ?? "");
  if (!/^\d{10}$/.test(account)) throw new OnboardError("INVALID_REQUEST", 400, "bankAccount must be 10 digits", "bankAccount");
  const bvn = String(b.bvn ?? "");
  if (!/^\d{11}$/.test(bvn)) throw new OnboardError("INVALID_REQUEST", 400, "bvn must be 11 digits", "bvn");
  const language = b.language ?? "pidgin";
  if (!LANGS.includes(language)) throw new OnboardError("INVALID_REQUEST", 400, "unsupported language", "language");
  if (b.consentAccepted !== true) throw new OnboardError("CONSENT_REQUIRED", 400, "Consent must be accepted", "consentAccepted");
  if (b.consentVersion !== CONSENT_VERSION) {
    throw new OnboardError("CONSENT_VERSION_MISMATCH", 400, "The consent text has changed. Reload and accept again", "consentVersion");
  }

  const bvnHash = idHash(bvn);
  const dup = db.prepare("SELECT 1 FROM merchants WHERE bvn_hash = ? OR bank_account = ? OR phone = ?").get(bvnHash, account, phone);
  if (dup) throw new OnboardError("ALREADY_ENROLLED", 409, "These details are already enrolled");

  const ident = await bank.verifyIdentity("bvn", bvn);
  if (!ident.verified || !ident.fullName) throw new OnboardError("IDENTITY_NOT_VERIFIED", 422, "BVN could not be verified", "bvn");

  let acct;
  try {
    acct = await bank.resolveAccount(account);
  } catch (e) {
    if (e instanceof BankError && e.code === "ACCOUNT_NOT_FOUND") {
      throw new OnboardError("ACCOUNT_NOT_FOUND", 422, "Account not found", "bankAccount");
    }
    throw e;
  }
  if (acct.status !== "active") throw new OnboardError("ACCOUNT_NOT_ACTIVE", 422, "Account is not active", "bankAccount");

  const m = matchNames(ident.fullName, acct.accountName);
  if (m.band === "mismatch") throw new OnboardError("NAME_MISMATCH", 422, "The BVN name does not match the account name");
  if (m.band === "needs_review") throw new OnboardError("NAME_NEEDS_REVIEW", 422, "Names are close but not identical, so this needs manual review");

  const merchantId = randomUUID();
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO merchants (id, phone, full_name, bvn_hash, bank_account, language, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(merchantId, phone, ident.fullName, bvnHash, account, language, now);
      db.prepare("INSERT INTO consents (id, merchant_id, text_version, given_at) VALUES (?,?,?,?)")
        .run(randomUUID(), merchantId, CONSENT_VERSION, now);
      for (const h of hooks) h(merchantId);
    })();
  } catch (e) {
    if (String((e as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")) {
      throw new OnboardError("ALREADY_ENROLLED", 409, "These details are already enrolled");
    }
    throw e;
  }
  return { merchantId, fullName: ident.fullName, language, rateBps: 200 };
}
