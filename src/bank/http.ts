import { RateLimiter } from "./limiter.js";
import { BankNetworkError } from "./types.js";

export type HttpResult = { status: number; body: any; replayed: boolean };

export class BankHttp {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private limiter: RateLimiter = new RateLimiter(),
    private timeoutMs = 25_000 // the gateway cuts off at 30s
  ) {}

  /** GETs are safe to retry on network errors and 5xx. */
  get(path: string): Promise<HttpResult> {
    return this.send("GET", path, undefined, {}, 2);
  }

  /** Money-moving POSTs are NEVER retried here (only 429, where nothing was processed). */
  post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
    return this.send("POST", path, body, headers, 0);
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    extra: Record<string, string>,
    retries: number
  ): Promise<HttpResult> {
    let rateTries = 0;
    let netTries = 0;
    for (;;) {
      await this.limiter.acquire();
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, {
          method,
          headers: {
            "x-api-key": this.apiKey,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...extra,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (netTries < retries) {
          netTries++;
          await sleep(500 * netTries);
          continue;
        }
        throw new BankNetworkError(`${method} ${sanitizePathForLog(path)}: ${(e as Error).message}`);
      }

      const text = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        // the gateway can return its own short, non-JSON body (e.g. a bare 401)
        parsed = { status: "error", error: { code: res.status === 401 ? "UNAUTHORIZED" : "BAD_GATEWAY", message: text.slice(0, 200) } };
      }

      if (res.status === 429 && rateTries < 3) {
        rateTries++;
        await sleep(Math.min(2000 * 2 ** (rateTries - 1), 15_000));
        continue;
      }
      if (res.status >= 500 && method === "GET" && netTries < retries) {
        netTries++;
        await sleep(500 * netTries);
        continue;
      }
      if (res.status >= 400) {
        console.warn(`[bank] ${method} ${sanitizePathForLog(path)} -> ${res.status} ${parsed?.error?.code ?? ""} ${parsed?.request_id ?? ""}`);
      }
      return { status: res.status, body: parsed, replayed: res.headers.get("idempotent-replayed") === "true" };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Logs route shape only: no query string, no account-like numbers, no transfer references.
const sanitizePathForLog = (path: string): string => {
  const [route] = path.split("?", 1);
  return route
    .split("/")
    .map((seg, i, all) =>
      all[i - 1] === "transfers" && !["intra", "interbank", "bulk"].includes(seg)
        ? ":ref"
        : seg.replace(/\d{6,}/g, ":redacted")
    )
    .join("/");
};