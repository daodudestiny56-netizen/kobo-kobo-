import { BankHttp } from "./http.js";
import { RateLimiter } from "./limiter.js";
import { HttpBankClient } from "./client.js";

// ONE limiter for the whole process. Tomiwa's model calls must import and use it too.
export const limiter = new RateLimiter(40, 60_000);

const base = process.env.BANK_BASE_URL ?? "http://bank-api.ingress-apisix.svc.cluster.local/v1";
const key = process.env.BANK_API_KEY ?? process.env.GATEWAY_KEY ?? "";
if (!key) console.warn("[bank] no API key set (BANK_API_KEY or GATEWAY_KEY)");

export const bank = new HttpBankClient(new BankHttp(base, key, limiter));
export * from "./types.js";
export * from "./refs.js";
export * from "./money.js";