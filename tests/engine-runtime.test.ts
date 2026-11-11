import assert from "node:assert/strict";
import Fastify from "fastify";
import { test } from "node:test";

test("production config requires credentials and keeps demo routes disabled by default", async () => {
  const { loadConfig, productionProblems } = await import("../server/src/config.ts");
  const config = loadConfig({ NODE_ENV: "production" });
  assert.equal(config.demoMode, false);
  const problems = productionProblems(config, { NODE_ENV: "production" });
  assert.equal(problems.includes("OPS_TOKEN is empty: the ops dashboard and demo controls would be open to the internet."), true);
  assert.equal(problems.some((problem) => problem.startsWith("BANK_API_KEY")), true);
});

test("engine withdrawal credits are never classified as sales", async () => {
  process.env.DB_PATH = ":memory:";
  const { isSale } = await import("../src/collector.js");
  const transaction = {
    reference: "WDR-test",
    account: "0123456789",
    type: "transfer",
    direction: "credit" as const,
    amountKobo: 10_000,
    feeKobo: 0,
    counterparty: null,
    channel: null,
    status: "successful",
    at: "2026-11-10T00:00:00.000Z",
  };
  assert.equal(isSale(transaction), false);
  assert.equal(isSale({ ...transaction, reference: "SWP-test" }), false);
  assert.equal(isSale({ ...transaction, reference: "SALE-test" }), true);
});

test("engine routes use the root database and refuse retirement-pot withdrawals", async () => {
  process.env.DB_PATH = ":memory:";

  const [{ db, migrate }, { bank }, { registerEngineRuntime }] = await Promise.all([
    import("../src/db.js"),
    import("../src/bank/index.js"),
    import("../server/src/integration/root-runtime.ts"),
  ]);
  assert.equal(migrate(), 4);

  const app = Fastify({ logger: false });
  const runtime = registerEngineRuntime(app, db, bank, false);
  try {
    const enrolled = await app.inject({
      method: "POST",
      url: "/api/v1/merchants",
      payload: {
        phone: "+2348031234567",
        fullName: "Ada Okafor",
        bvn: "12345678901",
        bankAccount: "0123456789",
      },
    });
    assert.equal(enrolled.statusCode, 201);
    const merchant = enrolled.json().data;
    assert.match(merchant.rsaPin, /^PEN\d{12}$/);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM pension_accounts WHERE merchant_id = ?").get(merchant.id) as { count: number }).count,
      1,
    );

    const withdrawal = await app.inject({
      method: "POST",
      url: "/api/v1/withdrawals",
      payload: { merchantId: merchant.id, amountNaira: "100", pot: "RETIREMENT" },
    });
    assert.equal(withdrawal.statusCode, 200);
    assert.equal(withdrawal.json().data.ok, false);
    assert.match(withdrawal.json().data.message, /50/);

    const ussd = await app.inject({
      method: "POST",
      url: "/api/v1/ussd",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "phoneNumber=%2B2348031234567&text=",
    });
    assert.equal(ussd.statusCode, 200);
    assert.equal(ussd.json().data.type, "CON");
  } finally {
    runtime.stop();
    await app.close();
    db.close();
  }
});
