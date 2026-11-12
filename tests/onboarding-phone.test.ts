import assert from "node:assert/strict";
import { test } from "node:test";

test("onboarding stores Nigerian numbers as +234 whatever way they are typed, and treats them as one number", async () => {
  process.env.DB_PATH = ":memory:";
  const [{ db, migrate }, onboarding, { bank }] = await Promise.all([
    import("../src/db.js"),
    import("../src/onboarding/service.js"),
    import("../src/bank/index.js"),
  ]);
  migrate();

  const originalVerifyIdentity = bank.verifyIdentity;
  const originalResolveAccount = bank.resolveAccount;
  bank.verifyIdentity = async () => ({ verified: true, fullName: "Ada Okafor", dob: null });
  bank.resolveAccount = async (accountNumber: string) => ({ accountNumber, accountName: "ADA OKAFOR", bankName: "Test Bank", status: "active" });
  const enrol = (phone: string, bankAccount: string, bvn: string) =>
    onboarding.onboard({ phone, bankAccount, bvn, consentAccepted: true, consentVersion: onboarding.CONSENT_VERSION });
  const stored = (id: string) => (db.prepare("SELECT phone FROM merchants WHERE id = ?").get(id) as { phone: string }).phone;

  try {
    assert.equal(stored((await enrol("0803 123 4567", "0123456781", "12345678911")).merchantId), "+2348031234567");
    assert.equal(stored((await enrol("234-803-123-4568", "0123456782", "12345678912")).merchantId), "+2348031234568");
    assert.equal(stored((await enrol("(0803) 123 4569", "0123456783", "12345678913")).merchantId), "+2348031234569");
    assert.equal(stored((await enrol("+2348031234560", "0123456784", "12345678914")).merchantId), "+2348031234560");

    // the same person typing their number another way is the same number
    await assert.rejects(enrol("08031234567", "0123456785", "12345678915"), (e: { code?: string }) => e.code === "ALREADY_ENROLLED");
    // a non-Nigerian number is kept as given, and junk is still refused
    assert.equal(stored((await enrol("+14155550123", "0123456786", "12345678916")).merchantId), "+14155550123");
    await assert.rejects(enrol("12345", "0123456787", "12345678917"), (e: { code?: string }) => e.code === "INVALID_REQUEST");
  } finally {
    bank.verifyIdentity = originalVerifyIdentity;
    bank.resolveAccount = originalResolveAccount;
  }
});
