import assert from "node:assert/strict";
import { test } from "node:test";

test("onboarding creates a simulated pension account atomically", async () => {
  process.env.DB_PATH = ":memory:";

  const [{ db, migrate }, onboarding, { bank }, { createPensionAccountOnboardingHook, newSimulatedRsaPin }] =
    await Promise.all([
      import("../src/db.js"),
      import("../src/onboarding/service.js"),
      import("../src/bank/index.js"),
      import("../src/pension/onboarding.js"),
    ]);

  assert.equal(migrate(), 3);
  assert.equal(migrate(), 0);
  let generated = 0;
  const pins = ["PEN000000000001", "PEN000000000001", "PEN000000000002"];
  onboarding.onOnboard(
    createPensionAccountOnboardingHook(db, () => pins[generated++] ?? "PEN000000000003", () => new Date("2026-11-10T00:00:00.000Z")),
  );

  let failHook = false;
  onboarding.onOnboard(() => {
    if (failHook) throw new Error("downstream engine hook failed");
  });

  const originalVerifyIdentity = bank.verifyIdentity;
  const originalResolveAccount = bank.resolveAccount;
  bank.verifyIdentity = async () => ({ verified: true, fullName: "Ada Okafor", dob: null });
  bank.resolveAccount = async (accountNumber: string) => ({
    accountNumber,
    accountName: "ADA OKAFOR",
    bankName: "Test Bank",
    status: "active",
  });

  try {
    const enrolled = await onboarding.onboard({
      phone: "+2348031234567",
      bankAccount: "0123456789",
      bvn: "12345678901",
      consentAccepted: true,
      consentVersion: onboarding.CONSENT_VERSION,
    });

    const pension = db
      .prepare("SELECT merchant_id, rsa_pin, pfa, created_at FROM pension_accounts WHERE merchant_id = ?")
      .get(enrolled.merchantId) as { merchant_id: string; rsa_pin: string; pfa: string; created_at: string };
    assert.equal(pension.merchant_id, enrolled.merchantId);
    assert.equal(pension.rsa_pin, "PEN000000000001");
    assert.equal(pension.pfa, "ACCESS_ARM_SIMULATED");
    assert.equal(pension.created_at, "2026-11-10T00:00:00.000Z");
    assert.match(newSimulatedRsaPin(), /^PEN\d{12}$/);
    assert.equal(generated, 1);

    failHook = true;
    await assert.rejects(
      onboarding.onboard({
        phone: "+2348031234568",
        bankAccount: "0123456790",
        bvn: "12345678902",
        consentAccepted: true,
        consentVersion: onboarding.CONSENT_VERSION,
      }),
      /downstream engine hook failed/,
    );

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM merchants").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM consents").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pension_accounts").get().count, 1);
    assert.equal(generated, 3);
  } finally {
    bank.verifyIdentity = originalVerifyIdentity;
    bank.resolveAccount = originalResolveAccount;
    db.close();
  }
});
