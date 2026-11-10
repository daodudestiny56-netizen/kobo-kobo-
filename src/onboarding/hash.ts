import { createHmac } from "node:crypto";

if (!process.env.IDENTITY_HMAC_KEY) console.warn("[identity] IDENTITY_HMAC_KEY not set, using the dev key");

// Keyed hash, so a leaked DB can't be reversed by hashing all 11-digit numbers.
export const idHash = (value: string): string =>
  createHmac("sha256", process.env.IDENTITY_HMAC_KEY ?? "dev-only-hmac-key").update(value).digest("hex");