import { createHmac, timingSafeEqual } from "node:crypto";

/** x-forge-signature = "sha256=" + HMAC-SHA256(secret, `${timestamp}.${rawBody}`), timestamp within 5 minutes. */
export function verifySignature(raw: string, ts: string, sig: string, secret: string, nowMs = Date.now()): boolean {
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > 300) return false;
  const mac = "sha256=" + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  const a = Buffer.from(mac), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
