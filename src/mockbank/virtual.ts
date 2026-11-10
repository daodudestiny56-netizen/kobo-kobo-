import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { accounts, BVNS, nowIso, onReset } from "./state.js";
import { ok, fail, requestId } from "./envelope.js";
import { idemLookup, idemSave } from "./idem.js";
import { emit } from "./webhooks.js";

type Inflow = {
  session_id: string;
  amount: number;
  sender: { name: string; account_number: string; bank_name: string };
  narration: string | null;
  received_at: string;
};
type VA = {
  number: string; accountNumber: string; customerName: string; reference: string;
  createdAt: string; totalKobo: number; inflows: Inflow[];
};

const vas = new Map<string, VA>();
onReset(() => vas.clear());

const view = (v: VA) => ({
  account_number: v.number,
  account_name: `FORGE / ${v.customerName.toUpperCase()}`,
  bank_name: "Xtradot Bank", nip_code: "000014", type: "dedicated",
  reference: v.reference, status: "active", created_at: v.createdAt,
  customer_name: v.customerName, total_received: v.totalKobo / 100,
  expected_amount: null, expires_at: null,
});

const validCodes = () => {
  const s = new Set<string>();
  for (const a of accounts.values()) {
    s.add(a.nip);
    if (a.cbn) s.add(a.cbn);
  }
  return s;
};

export async function virtualRoutes(v1: FastifyInstance) {
  v1.post<{ Body: Record<string, unknown> }>("/virtual-accounts", async (req, reply) => {
    const b = req.body ?? {};
    const key = req.headers["idempotency-key"];
    if (typeof key === "string" && key) {
      const look = idemLookup("va-create", key, b);
      if (look.kind === "conflict") return fail(reply, "DUPLICATE_REQUEST", "Idempotency-Key reused with a different request body");
      if (look.kind === "replay") return reply.code(look.code).header("Idempotent-Replayed", "true").send(look.payload);
    }
    for (const f of ["account_number", "customer_name", "bvn", "reference"]) {
      if (!b[f]) return fail(reply, "INVALID_REQUEST", `${f} is required`, { field: f });
    }
    const acct = accounts.get(String(b.account_number));
    if (!acct || !acct.team) {
      return fail(reply, "ACCOUNT_NOT_FOUND", `Account ${b.account_number} is not one of your team accounts`, { nip_response_code: "07" });
    }
    if (BVNS[acct.number] !== String(b.bvn)) {
      return fail(reply, "BVN_MISMATCH", "BVN does not match the account holder");
    }
    if ([...vas.values()].some((v) => v.reference === b.reference)) {
      return fail(reply, "DUPLICATE_REQUEST", "Reference already used");
    }
    let number = "";
    do { number = `99${randomInt(10_000_000, 99_999_999)}`; } while (vas.has(number));
    const va: VA = {
      number, accountNumber: acct.number, customerName: String(b.customer_name),
      reference: String(b.reference), createdAt: nowIso(), totalKobo: 0, inflows: [],
    };
    vas.set(number, va);
    const payload = { status: "success", message: "Virtual account created", data: view(va), meta: null, request_id: requestId() };
    if (typeof key === "string" && key) idemSave("va-create", key, b, 201, payload);
    return reply.code(201).send(payload);
  });

  v1.get<{ Params: { n: string } }>("/virtual-accounts/:n", async (req, reply) => {
    const va = vas.get(req.params.n);
    if (!va) return fail(reply, "ACCOUNT_NOT_FOUND", "Virtual account not found", { nip_response_code: "07" });
    return ok(reply, { ...view(va), inflows: va.inflows });
  });

  // Mirrors the real behaviour on purpose: credits the VIRTUAL account only.
  // The linked bank account is never touched, and our `reference` is ignored.
  v1.post<{ Params: { n: string }; Body: Record<string, unknown> }>(
    "/virtual-accounts/:n/simulate-inflow",
    async (req, reply) => {
      const va = vas.get(req.params.n);
      if (!va) return fail(reply, "ACCOUNT_NOT_FOUND", "Virtual account not found", { nip_response_code: "07" });
      const b = req.body ?? {};

      const key = req.headers["idempotency-key"];
      if (typeof key === "string" && key) {
        const look = idemLookup("va-inflow", key, b);
        if (look.kind === "conflict") return fail(reply, "DUPLICATE_REQUEST", "Idempotency-Key reused with a different request body");
        if (look.kind === "replay") return reply.code(look.code).header("Idempotent-Replayed", "true").send(look.payload);
      }

      if (typeof b.amount !== "number" || b.amount <= 0) {
        return fail(reply, "INVALID_REQUEST", "amount must be a positive number", { field: "amount" });
      }
      const kobo = Math.round(b.amount * 100);
      if (!b.sender_account) return fail(reply, "INVALID_REQUEST", "sender_account is required", { field: "sender_account" });
      const code = String(b.sender_bank_code ?? "");
      if (!validCodes().has(code)) {
        return fail(reply, "INVALID_REQUEST", "sender_bank_code must be a CBN or NIP code", { field: "sender_bank_code" });
      }

      const known = accounts.get(String(b.sender_account));
      const bankName = known?.bank ?? [...accounts.values()].find((a) => a.nip === code || a.cbn === code)?.bank ?? "Unknown Bank";
      const name = (known?.name ?? String(b.sender_name ?? "UNKNOWN SENDER")).toUpperCase();

      // Session id: bank code + yyMMddHHmmss (WAT, UTC+1) + 12 random digits
      const wat = new Date(Date.now() + 3_600_000).toISOString().replace(/[-:T]/g, "").slice(2, 14);
      const rand = Array.from({ length: 12 }, () => randomInt(0, 10)).join("");
      const session_id = `${code.padStart(6, "0")}${wat}${rand}`;

      const inflow: Inflow = {
        session_id, amount: kobo / 100,
        sender: { name, account_number: String(b.sender_account), bank_name: bankName },
        narration: b.narration ? String(b.narration) : null,
        received_at: nowIso(),
      };
      va.inflows.push(inflow);
      va.totalKobo += kobo;

      emit("virtual_account.credited", { ...inflow, account_number: va.number, reference: va.reference });

      const payload = {
        status: "success", message: "Inflow received",
        data: { ...inflow, account_number: va.number, reference: va.reference },
        meta: null, request_id: requestId(),
      };
      if (typeof key === "string" && key) idemSave("va-inflow", key, b, 200, payload);
      return reply.code(200).send(payload);
    }
  );
}