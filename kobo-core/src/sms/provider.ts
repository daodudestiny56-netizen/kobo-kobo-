/** Outbound SMS transport. The dispatcher owns retries; providers just report whether a failure is worth retrying. */
export interface SmsProvider {
  send(to: string, body: string): Promise<{ messageId: string }>;
}

export class SmsSendError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SmsSendError';
  }
}

/** Dev/test provider: prints and remembers messages. `failNext` simulates carrier trouble. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly sent: { to: string; body: string; messageId: string }[] = [];
  private failures: boolean[] = [];
  constructor(private readonly log = false) {}

  failNext(times = 1, retryable = true): void {
    for (let i = 0; i < times; i++) this.failures.push(retryable);
  }

  async send(to: string, body: string) {
    const f = this.failures.shift();
    if (f !== undefined) throw new SmsSendError('simulated carrier failure', f);
    const messageId = `console-${this.sent.length + 1}`;
    this.sent.push({ to, body, messageId });
    if (this.log) console.log(`[sms] -> ${to}: ${body}`);
    return { messageId };
  }
}

/**
 * Africa's Talking bulk SMS. Username "sandbox" uses their sandbox host.
 * statusCode 100/101/102 = accepted; anything else on a 2xx is a per-recipient rejection (not retryable).
 */
export class AfricasTalkingProvider implements SmsProvider {
  constructor(
    private readonly username: string,
    private readonly apiKey: string,
    private readonly senderId = '',
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(to: string, body: string): Promise<{ messageId: string }> {
    const host = this.username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const form = new URLSearchParams({ username: this.username, to, message: body });
    if (this.senderId) form.set('from', this.senderId);

    let res: Response;
    try {
      res = await this.fetchFn(`https://${host}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey: this.apiKey, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SmsSendError(`Africa's Talking unreachable: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) throw new SmsSendError(`Africa's Talking ${res.status}`, true);
    if (!res.ok) throw new SmsSendError(`Africa's Talking ${res.status}: ${text.slice(0, 200)}`, false);

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SmsSendError('Africa\'s Talking returned a non-JSON body', true);
    }
    const r = json?.SMSMessageData?.Recipients?.[0];
    if (!r) throw new SmsSendError(`No recipient in response: ${json?.SMSMessageData?.Message ?? 'unknown'}`, false);
    if (![100, 101, 102].includes(Number(r.statusCode))) throw new SmsSendError(`Rejected: ${r.status ?? r.statusCode}`, false);
    return { messageId: String(r.messageId) };
  }
}
