/** Outbound voice transport. The voice service owns retries; providers report whether a failure is worth retrying. */
export interface VoiceProvider {
  /** Ask the telco to call `to`. When the trader answers, the telco requests our callback with `requestId` as clientRequestId. */
  placeCall(to: string, o: { requestId: string }): Promise<{ callId: string }>;
}

export class VoiceCallError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VoiceCallError';
  }
}

export class ConsoleVoiceProvider implements VoiceProvider {
  readonly calls: { to: string; requestId: string; callId: string }[] = [];
  private failures: boolean[] = [];
  constructor(private readonly log = false) {}

  failNext(times = 1, retryable = true): void {
    for (let i = 0; i < times; i++) this.failures.push(retryable);
  }

  async placeCall(to: string, o: { requestId: string }) {
    const f = this.failures.shift();
    if (f !== undefined) throw new VoiceCallError('simulated carrier failure', f);
    const callId = `console-call-${this.calls.length + 1}`;
    this.calls.push({ to, requestId: o.requestId, callId });
    if (this.log) console.log(`[voice] calling ${to} (request ${o.requestId})`);
    return { callId };
  }
}

/** Africa's Talking Voice: POST /call. A "Queued" entry means accepted; anything else is a rejection. */
export class AfricasTalkingVoiceProvider implements VoiceProvider {
  constructor(
    private readonly username: string,
    private readonly apiKey: string,
    private readonly callFrom: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async placeCall(to: string, o: { requestId: string }): Promise<{ callId: string }> {
    const host = this.username === 'sandbox' ? 'voice.sandbox.africastalking.com' : 'voice.africastalking.com';
    const form = new URLSearchParams({ username: this.username, from: this.callFrom, to, clientRequestId: o.requestId });
    let res: Response;
    try {
      res = await this.fetchFn(`https://${host}/call`, {
        method: 'POST',
        headers: { apiKey: this.apiKey, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new VoiceCallError(`Africa's Talking voice unreachable: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) throw new VoiceCallError(`Africa's Talking voice ${res.status}`, true);
    if (!res.ok) throw new VoiceCallError(`Africa's Talking voice ${res.status}: ${text.slice(0, 200)}`, false);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new VoiceCallError("Africa's Talking voice returned a non-JSON body", true);
    }
    const entry = json?.entries?.[0];
    if (!entry || entry.status !== 'Queued') {
      const why = entry?.status ?? json?.errorMessage ?? 'unknown';
      // Busy/temporary conditions are worth another try; a bad number or an unconfigured account is not.
      throw new VoiceCallError(`Call not queued: ${why}`, /busy|temporar|unavailable|congest/i.test(String(why)));
    }
    return { callId: o.requestId };
  }
}
