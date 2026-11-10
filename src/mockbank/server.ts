import Fastify from "fastify";
import { accounts, transactions, type Tx } from "./state.js";
import { ok, fail } from "./envelope.js";
import { transferRoutes } from "./transfers.js";
import { webhookRoutes } from "./webhooks.js";
import { virtualRoutes } from "./virtual.js";

const KEY = process.env.MOCK_KEY ?? "mock-key";
const app = Fastify({ logger: false });

// Auth + shared rate limit (60 requests/min, like the real gateway)
const hits: number[] = [];
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/healthz") return;
  if (req.headers["x-api-key"] !== KEY) {
    return fail(reply, "UNAUTHORIZED", "Missing or invalid API key");
  }
  const t = Date.now();
  while (hits.length && t - hits[0] > 60_000) hits.shift();
  if (hits.length >= 60) return fail(reply, "RATE_LIMITED", "Rate limit exceeded");
  hits.push(t);
});

app.get("/healthz", async () => ({ ok: true }));

const row = (t: Tx) => ({
  reference: t.reference, account: t.account, type: t.type, direction: t.direction,
  amount: t.kobo / 100, fee: t.feeKobo / 100, vat: t.vatKobo / 100, stamp_duty: t.stampKobo / 100,
  balance_after: t.balanceAfterKobo / 100, counterparty_name: t.counterparty,
  channel: t.channel, status: t.status, at: t.at,
});

app.register(
  async (v1) => {
    await v1.register(transferRoutes);
    await v1.register(webhookRoutes);
    await v1.register(virtualRoutes);

    v1.get<{ Params: { n: string } }>("/accounts/:n/balance", async (req, reply) => {
      const a = accounts.get(req.params.n);
      // Real sandbox: only team accounts have balances
      if (!a || !a.team) {
        return fail(reply, "ACCOUNT_NOT_FOUND", `Account ${req.params.n} is not one of your team accounts`, {
          nip_response_code: "07",
        });
      }
      return ok(reply, {
        account_number: a.number, account_name: a.name,
        available_balance: a.kobo / 100, ledger_balance: a.kobo / 100,
        currency: "NGN", kyc_level: a.kyc, status: a.status,
      });
    });

    v1.get<{ Querystring: { account_number?: string; bank_code?: string } }>(
      "/accounts/resolve",
      async (req, reply) => {
        const { account_number, bank_code } = req.query;
        if (!account_number) return fail(reply, "INVALID_REQUEST", "account_number is required", { field: "account_number" });
        if (!bank_code) return fail(reply, "INVALID_REQUEST", "bank_code is required", { field: "bank_code" });
        const a = accounts.get(account_number);
        if (!a || (a.nip !== bank_code && a.cbn !== bank_code)) {
          return fail(reply, "ACCOUNT_NOT_FOUND", `Account ${account_number} not found`, { nip_response_code: "07" });
        }
        return ok(
          reply,
          {
            account_number: a.number, account_name: a.name, bank_name: a.bank,
            nip_code: a.nip, ...(a.cbn ? { cbn_code: a.cbn } : {}), account_status: a.status,
          },
          "Account resolved"
        );
      }
    );

    v1.get("/tariff", async (_req, reply) =>
      ok(reply, {
        tariff: "sandbox",
        examples: {
          intrabank_3000: { fee: 0.0, vat: 0.0, stamp_duty: 0.0, total_charges: 0.0 },
          nip_3000: { fee: 10.0, vat: 0.75, stamp_duty: 0.0, total_charges: 10.75 },
          intrabank_25000: { fee: 0.0, vat: 0.0, stamp_duty: 0.0, total_charges: 0.0 },
          nip_25000: { fee: 25.0, vat: 1.88, stamp_duty: 0.0, total_charges: 26.88 },
          intrabank_75000: { fee: 0.0, vat: 0.0, stamp_duty: 0.0, total_charges: 0.0 },
          nip_75000: { fee: 50.0, vat: 3.75, stamp_duty: 0.0, total_charges: 53.75 },
        },
      })
    );

    // Mirrors the real bug on purpose: account_number is IGNORED, every team account comes back.
    // Newest first. Clients must filter on the `account` field themselves.
    v1.get<{ Querystring: { page?: string; per_page?: string } }>("/transactions", async (req, reply) => {
      const page = Math.max(1, Number(req.query.page) || 1);
      const per = Math.min(100, Math.max(1, Number(req.query.per_page) || 20));
      const all = [...transactions].reverse();
      const slice = all.slice((page - 1) * per, page * per);
      return ok(reply, slice.map(row), "Request completed", {
        page, per_page: per, total: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)),
      });
    });
  },
  { prefix: "/v1" }
);

const port = Number(process.env.MOCK_PORT ?? 4010);
app.listen({ host: "127.0.0.1", port }).then(() => console.log(`mock bank on :${port}`));