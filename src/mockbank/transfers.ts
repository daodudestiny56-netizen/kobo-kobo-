import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { accounts, transactions, nowIso, reset, BVNS, type Account } from "./state.js";
import { ok, fail, requestId } from "./envelope.js";
import { idemLookup, idemSave, idemClear } from "./idem.js";
import { emit } from "./webhooks.js";

// MOCK_FAST=1 shrinks the delays: 30s -> 2s, 60s -> 4s, 120s -> 8s
const fast = !!process.env.MOCK_FAST;
const secs = (s: number) => (fast ? Math.max(1, Math.round(s / 15)) : s) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// [single, daily] in kobo
const LIMITS: Record<string, [number, number]> = {
  "1": [5_000_000, 30_000_000],
  "2": [10_000_000, 50_000_000],
  "3": [500_000_000, 2_500_000_000],
  corp: [1_000_000_000, 10_000_000_000],
};

type Transfer = {
  reference: string;
  txnId: string;
  srcNo: string;
  dstNo: string;
  kobo: number;
  narration: string;
  status: "pending" | "successful" | "failed" | "reversed";
  createdAt: string;
  completedAt: string | null;
  srcAfterKobo: number;
  withholdFirstWebhook: boolean; // used by the webhook batch for the .05 trigger
};

const transfers = new Map<string, Transfer>();
const enquiries = new Map<string, { account: string; expiresAt: number; used: boolean }>();
const timers: NodeJS.Timeout[] = [];
let txnSeq = 5520;

const later = (s: number, fn: () => void) => {
  timers.push(setTimeout(fn, secs(s)));
};

// Only call for team accounts: they are the only ones with tracked balances.
function book(a: Account, direction: "credit" | "debit", kobo: number, reference: string, type: string, counterparty: string) {
  a.kobo += direction === "credit" ? kobo : -kobo;
  transactions.push({
    reference, account: a.number, type, direction, kobo,
    feeKobo: 0, vatKobo: 0, stampKobo: 0, balanceAfterKobo: a.kobo,
    counterparty, channel: "intrabank", status: "successful", at: nowIso(),
  });
}

const view = (t: Transfer) => {
  const s = accounts.get(t.srcNo)!;
  const d = accounts.get(t.dstNo)!;
  return {
    reference: t.reference, transaction_id: t.txnId, channel: "intrabank",
    amount: t.kobo / 100, fee: 0.0, vat: 0.0, stamp_duty: 0.0, total_debit: t.kobo / 100,
    currency: "NGN", status: t.status,
    source: { account_number: s.number, account_name: s.name, balance_after: t.srcAfterKobo / 100 },
    destination: { account_number: d.number, account_name: d.name, bank_name: d.bank },
    narration: t.narration, created_at: t.createdAt,
    nip_response_code: t.status === "successful" ? "00" : t.status === "pending" ? "09" : "91",
    completed_at: t.completedAt,
  };
};

export async function transferRoutes(v1: FastifyInstance) {
  v1.post<{ Body: { account_number?: string } }>("/transfers/intra/name-enquiry", async (req, reply) => {
    const no = req.body?.account_number;
    if (!no) return fail(reply, "INVALID_REQUEST", "account_number is required", { field: "account_number" });
    if (no === "0000000002") {
      await sleep(10_000);
      return fail(reply, "TIMEOUT", "Name enquiry timed out");
    }
    const a = accounts.get(no);
    if (no === "0000000001" || !a || a.nip !== "000014") {
      return fail(reply, "ACCOUNT_NOT_FOUND", `Account ${no} not found`, { nip_response_code: "07" });
    }
    if (a.status === "dormant") return fail(reply, "ACCOUNT_DORMANT", "Beneficiary account is dormant");
    if (a.status === "frozen") return fail(reply, "BENEFICIARY_FROZEN", "Beneficiary account is frozen");

    const ref = `NE-INTRA-${nowIso().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
    const expiresAt = Date.now() + 10 * 60_000;
    enquiries.set(ref, { account: a.number, expiresAt, used: false });
    const bvn = BVNS[a.number];
    return ok(
      reply,
      {
        name_enquiry_ref: ref, account_number: a.number, account_name: a.name,
        bank_name: a.bank, account_status: a.status, kyc_level: a.kyc,
        bvn_masked: bvn ? `${bvn.slice(0, 3)}*****${bvn.slice(-3)}` : null,
        currency: "NGN",
        expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
        nip_code: a.nip,
      },
      "Account resolved"
    );
  });

  v1.post<{ Body: Record<string, unknown> }>("/transfers/intra", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) {
      return fail(reply, "INVALID_REQUEST", "Idempotency-Key header is required", { field: "Idempotency-Key" });
    }
    const b = req.body ?? {};

    const look = idemLookup("intra", key, b);
    if (look.kind === "conflict") {
      return fail(reply, "DUPLICATE_REQUEST", "Idempotency-Key reused with a different request body");
    }
    if (look.kind === "replay") {
      return reply.code(look.code).header("Idempotent-Replayed", "true").send(look.payload);
    }

    for (const f of ["source_account", "destination_account", "name_enquiry_ref", "amount", "narration", "reference"]) {
      if (b[f] === undefined || b[f] === null || b[f] === "") {
        return fail(reply, "INVALID_REQUEST", `${f} is required`, { field: f });
      }
    }
    if (typeof b.amount !== "number") {
      return fail(reply, "INVALID_REQUEST", "amount must be a number", { field: "amount" });
    }
    const kobo = Math.round(b.amount * 100);
    if (!Number.isFinite(b.amount) || kobo <= 0 || Math.abs(b.amount * 100 - kobo) > 1e-6) {
      return fail(reply, "INVALID_REQUEST", "amount must be positive with at most 2 decimals", { field: "amount" });
    }

    const ref = String(b.reference);
    if (ref.startsWith("DUP-") || transfers.has(ref)) {
      return fail(reply, "DUPLICATE_REQUEST", "Reference already used");
    }

    const src = accounts.get(String(b.source_account));
    if (!src || !src.team) {
      return fail(reply, "ACCOUNT_NOT_FOUND", `Account ${b.source_account} is not one of your team accounts`, { nip_response_code: "07" });
    }
    if (src.status !== "active") return fail(reply, "ACCOUNT_RESTRICTED", "Source account is restricted");

    const dst = accounts.get(String(b.destination_account));
    if (!dst || dst.nip !== "000014") {
      return fail(reply, "ACCOUNT_NOT_FOUND", `Account ${b.destination_account} not found`, { nip_response_code: "07" });
    }
    if (dst.number === src.number) return fail(reply, "INVALID_REQUEST", "Cannot transfer to the same account", { field: "destination_account" });
    if (dst.status === "dormant") return fail(reply, "ACCOUNT_DORMANT", "Beneficiary account is dormant");
    if (dst.status === "frozen") return fail(reply, "BENEFICIARY_FROZEN", "Beneficiary account is frozen");

    const ne = enquiries.get(String(b.name_enquiry_ref));
    if (!ne) return fail(reply, "NAME_ENQUIRY_MISMATCH", "Unknown name enquiry reference");
    if (Date.now() > ne.expiresAt) return fail(reply, "NAME_ENQUIRY_EXPIRED", "Name enquiry reference expired");
    if (ne.used) return fail(reply, "DUPLICATE_REQUEST", "Name enquiry reference already used");
    if (ne.account !== dst.number) return fail(reply, "NAME_ENQUIRY_MISMATCH", "Destination does not match the name enquiry");
    ne.used = true;

    const forced = String(req.headers["x-test-outcome"] ?? "");
    const cents = kobo % 100;
    if ((!forced && cents === 1) || src.kobo < kobo) {
      return fail(reply, "INSUFFICIENT_FUNDS", "Balance below amount plus charges");
    }
    const [single, daily] = LIMITS[src.kyc === null ? "corp" : String(src.kyc)];
    if (kobo > single) return fail(reply, "LIMIT_EXCEEDED", "Single transaction limit exceeded");
    const today = nowIso().slice(0, 10);
    const spent = transactions
      .filter((t) => t.account === src.number && t.direction === "debit" && t.type === "transfer" && t.at.startsWith(today))
      .reduce((s, t) => s + t.kobo, 0);
    if (spent + kobo > daily) return fail(reply, "LIMIT_EXCEEDED", "Daily limit exceeded");

    const t: Transfer = {
      reference: ref, txnId: `txn_${++txnSeq}`, srcNo: src.number, dstNo: dst.number, kobo,
      narration: String(b.narration), status: "pending", createdAt: nowIso(), completedAt: null,
      srcAfterKobo: src.kobo, withholdFirstWebhook: !forced && cents === 5,
    };
    transfers.set(ref, t);

    const send = (code: number, body: unknown) => {
      idemSave("intra", key, b, code, body);
      return reply.code(code).send(body);
    };
    const success = (msg: string) => ({ status: "success", message: msg, data: view(t), meta: null, request_id: requestId() });

    const settle = () => {
      book(src, "debit", kobo, ref, "transfer", dst.name);
      if (dst.team) book(dst, "credit", kobo, ref, "transfer", src.name);
      t.srcAfterKobo = src.kobo;
      t.status = "successful";
      t.completedAt = nowIso();
      emit("transfer.successful", view(t), t.withholdFirstWebhook);
    };

    const outcome = forced || (cents === 2 ? "timeout" : cents === 3 ? "pending" : "successful");

    if (outcome === "timeout") {
      // Debited, outcome unknown. Fails and is reversed later. The client must requery, never resend.
      book(src, "debit", kobo, ref, "transfer", dst.name);
      later(30, () => {
        book(src, "credit", kobo, `${ref}-REV`, "reversal", dst.name);
        t.srcAfterKobo = src.kobo;
        t.status = "failed";
        t.completedAt = nowIso();
        emit("transfer.failed", view(t));
      });
      return send(504, {
        status: "error",
        error: { code: "TIMEOUT", message: "Transfer timed out. Query the status before retrying" },
        request_id: requestId(),
      });
    }

    if (outcome === "pending") {
      emit("transfer.pending", view(t));
      later(120, settle);
      return send(202, success("Transfer pending"));
    }

    if (outcome === "failed") {
      t.status = "failed";
      t.completedAt = nowIso();
      emit("transfer.failed", view(t));
      return send(503, {
        status: "error",
        error: { code: "BANK_UNAVAILABLE", message: "Transfer failed" },
        request_id: requestId(),
      });
    }

    settle();
    if (outcome === "reversed") {
      later(60, () => {
        book(src, "credit", kobo, `${ref}-REV`, "reversal", dst.name);
        if (dst.team) book(dst, "debit", kobo, `${ref}-REV`, "reversal", src.name);
        t.srcAfterKobo = src.kobo;
        t.status = "reversed";
        t.completedAt = nowIso();
        emit("transfer.reversed", view(t));
      });
    }
    return send(201, success("Transfer successful"));
  });

  v1.get<{ Params: { reference: string } }>("/transfers/:reference", async (req, reply) => {
    const t = transfers.get(req.params.reference);
    if (!t) return fail(reply, "NOT_FOUND", `Transfer ${req.params.reference} not found`);
    return ok(reply, view(t));
  });

  v1.post("/admin/reset", async (_req, reply) => {
    for (const h of timers) clearTimeout(h);
    timers.length = 0;
    transfers.clear();
    enquiries.clear();
    idemClear();
    reset();
    return ok(reply, { reset: true }, "Team state reset");
  });
}