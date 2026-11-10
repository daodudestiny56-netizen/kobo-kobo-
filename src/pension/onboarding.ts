import { randomInt, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof Database>;

const RSA_PIN_ATTEMPTS = 5;

export function newSimulatedRsaPin(): string {
  return `PEN${Array.from({ length: 12 }, () => randomInt(0, 10)).join("")}`;
}

export function createPensionAccountOnboardingHook(
  database: SqliteDatabase,
  generatePin: () => string = newSimulatedRsaPin,
  now: () => Date = () => new Date(),
): (merchantId: string) => void {
  return (merchantId) => {
    const createdAt = now().toISOString();
    for (let attempt = 0; attempt < RSA_PIN_ATTEMPTS; attempt++) {
      try {
        database
          .prepare("INSERT INTO pension_accounts (id, merchant_id, rsa_pin, created_at) VALUES (?, ?, ?, ?)")
          .run(randomUUID(), merchantId, generatePin(), createdAt);
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed: pension_accounts.rsa_pin")
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Could not allocate a unique simulated RSA PIN after 5 attempts.");
  };
}
