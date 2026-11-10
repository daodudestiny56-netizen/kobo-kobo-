import { randomUUID } from "node:crypto";
import { BankHttp } from "./http.js";
import { toKobo, toNaira } from "./money.js";
import {
  BankError, BankNetworkError,
  type AwaitOptions, type BankClient, type BankTransaction, type Kobo,
  type IdentityRecord, type NameEnquiry, type ResolvedAccount, type SendResult, type Transfer, type TransferRequest,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(res: { status: number; body: any }): never {
  const e = res.body?.error ?? {};
  throw new BankError(e.code ?? "UNKNOWN", e.message ?? `HTTP ${res.status}`, res.status, res.body?.request_id, e.field);
}

function mapTransfer(d: any): Transfer {
  return {
    reference: d.reference,
    transactionId: d.transaction_id,
    status: d.status,
    amountKobo: toKobo(d.amount),
    feeKobo: toKobo(d.fee ?? 0),
    vatKobo: toKobo(d.vat ?? 0),
    stampDutyKobo: toKobo(d.stamp_duty ?? 0),
    totalDebitKobo: toKobo(d.total_debit ?? d.amount),
    sourceAccount: d.source?.account_number,
    destinationAccount: d.destination?.account_number,
    sourceBalanceAfterKobo: toKobo(d.source?.balance_after ?? 0),
    createdAt: d.created_at,
    completedAt: d.completed_at ?? null,
  };
}

export class HttpBankClient implements BankClient {
  constructor(private http: BankHttp) {}

  async listWebhooks(): Promise<{ id: string; url: string }[]> {
    const res = await this.http.get("/webhooks");
    if (res.status >= 400) fail(res);
    const d = res.body.data;
    const arr: any[] = Array.isArray(d) ? d : d?.webhooks ?? [];
    return arr.map((w) => ({ id: w.id, url: w.url }));
  }

  async deleteWebhook(id: string): Promise<void> {
    const res = await this.http.del(`/webhooks/${encodeURIComponent(id)}`);
    if (res.status >= 400 && res.status !== 404) fail(res);
  }

  /** The secret is returned ONCE. Response field names are unconfirmed against the real bank. */
  async registerWebhook(url: string, events: string[]): Promise<{ id: string; secret: string }> {
    const res = await this.http.post("/webhooks", { url, events }, { "Idempotency-Key": randomUUID() });
    if (res.status >= 400) fail(res);
    const d = res.body.data ?? {};
    const secret = d.webhook_secret ?? d.secret;
    if (!secret) throw new Error("webhook registered but no secret in the response");
    return { id: d.id, secret };
  }

  async getBalanceKobo(account: string): Promise<Kobo> {
    const res = await this.http.get(`/accounts/${account}/balance`);
    if (res.status >= 400) fail(res);
    return toKobo(res.body.data.available_balance);
  }

  async resolveAccount(account: string, bankCode = "000014"): Promise<ResolvedAccount> {
    const res = await this.http.get(`/accounts/resolve?account_number=${account}&bank_code=${bankCode}`);
    if (res.status >= 400) fail(res);
    const d = res.body.data;
    return { accountNumber: d.account_number, accountName: d.account_name, bankName: d.bank_name, status: d.account_status };
  }

  async nameEnquiry(account: string): Promise<NameEnquiry> {
    const res = await this.http.post("/transfers/intra/name-enquiry", { account_number: account });
    if (res.status >= 400) fail(res);
    const d = res.body.data;
    return { ref: d.name_enquiry_ref, accountNumber: d.account_number, accountName: d.account_name, kycLevel: d.kyc_level ?? null, expiresAt: d.expires_at };
  }

  /** Body shape and response fields are NOT confirmed against the real bank yet; the mapping is deliberately tolerant. */
  async verifyIdentity(kind: "bvn" | "nin", number: string): Promise<IdentityRecord> {
    const res = await this.http.post(`/identity/${kind}/verify`, { [kind]: number });
    if (res.status === 422 || res.status === 404) return { verified: false, fullName: null, dob: null };
    if (res.status >= 400) fail(res);
    const d = res.body.data ?? {};
    const parts = [d.first_name ?? d.firstName, d.middle_name ?? d.middleName, d.last_name ?? d.lastName ?? d.surname];
    const fullName: string | null = d.full_name ?? d.fullName ?? d.name ?? (parts.filter(Boolean).join(" ") || null);
    const verified = (d.verified ?? d.match ?? true) !== false && !!fullName;
    return { verified, fullName, dob: d.dob ?? d.date_of_birth ?? null };
  }

  async sendIntra(req: TransferRequest): Promise<SendResult> {
    if (!Number.isInteger(req.amountKobo) || req.amountKobo <= 0) throw new Error("amountKobo must be a positive integer");
    if (req.reference.startsWith("DUP-")) throw new Error("reference must not start with DUP-");

    let res;
    try {
      res = await this.http.post(
        "/transfers/intra",
        {
          source_account: req.sourceAccount,
          destination_account: req.destinationAccount,
          name_enquiry_ref: req.nameEnquiryRef,
          amount: toNaira(req.amountKobo),
          narration: req.narration,
          reference: req.reference,
        },
        { "Idempotency-Key": req.idempotencyKey }
      );
    } catch (e) {
      if (e instanceof BankNetworkError) return { outcome: "unknown", reference: req.reference, reason: e.message };
      throw e;
    }

    const code: string | undefined = res.body?.error?.code;
    if (res.status === 200 || res.status === 201 || res.status === 202) {
      const t = mapTransfer(res.body.data);
      if (t.status === "successful") return { outcome: "settled", transfer: t };
      if (t.status === "pending") return { outcome: "pending", transfer: t };
      return { outcome: "unknown", reference: req.reference, reason: `unexpected status ${t.status}` };
    }
    // Anything that might have reached the bank is "unknown": requery, never resend.
    if (res.status >= 500 || code === "TIMEOUT") {
      return { outcome: "unknown", reference: req.reference, reason: `${res.status} ${code ?? ""} ${res.body?.request_id ?? ""}`.trim() };
    }
    if (code === "DUPLICATE_REQUEST") {
      return { outcome: "unknown", reference: req.reference, reason: "duplicate: check the bank for this reference" };
    }
    return { outcome: "failed", code: code ?? "UNKNOWN", message: res.body?.error?.message ?? `HTTP ${res.status}` };
  }

  async getTransfer(reference: string): Promise<Transfer | null> {
    const res = await this.http.get(`/transfers/${encodeURIComponent(reference)}`);
    if (res.status === 404) return null;
    if (res.status >= 400) fail(res);
    return mapTransfer(res.body.data);
  }

  /** Polls until the status leaves "pending". Returns the last known state, which may still be
   *  pending (or null) if maxWait runs out: the caller keeps the sweep UNKNOWN and requeries later. */
  async awaitFinal(reference: string, opts: AwaitOptions = {}): Promise<Transfer | null> {
    const maxWait = opts.maxWaitMs ?? 150_000;
    let delay = opts.firstDelayMs ?? 2_000;
    const start = Date.now();
    let last: Transfer | null = null;
    for (;;) {
      try {
        last = await this.getTransfer(reference);
        if (last && last.status !== "pending") return last;
      } catch (e) {
        if (!(e instanceof BankNetworkError)) throw e;
      }
      if (Date.now() - start + delay > maxWait) return last;
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /** Team-wide (the bank ignores the account filter), newest first, stops paging once older than sinceIso. */
  async listTransactions(opts: { sinceIso?: string } = {}): Promise<BankTransaction[]> {
    const out: BankTransaction[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.http.get(`/transactions?page=${page}&per_page=100`);
      if (res.status >= 400) fail(res);
      const rows: any[] = res.body.data ?? [];
      for (const r of rows) {
        if (opts.sinceIso && r.at < opts.sinceIso) continue;
        out.push({
          reference: r.reference, account: r.account, type: r.type, direction: r.direction,
          amountKobo: toKobo(r.amount), feeKobo: toKobo(r.fee ?? 0),
          counterparty: r.counterparty_name ?? null, channel: r.channel ?? null, status: r.status, at: r.at,
        });
      }
      const totalPages = res.body.meta?.total_pages ?? page;
      if (rows.length === 0 || page >= totalPages) break;
      if (opts.sinceIso && rows[rows.length - 1].at < opts.sinceIso) break;
    }
    return out;
  }

  async listAccountTransactions(account: string, opts: { sinceIso?: string } = {}): Promise<BankTransaction[]> {
    return (await this.listTransactions(opts)).filter((r) => r.account === account);
  }
}