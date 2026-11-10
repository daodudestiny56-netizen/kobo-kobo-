// Sliding window. The real limit is 60/min for the WHOLE team (bank + AI models),
// so we cap ourselves at 40 and leave headroom.
export class RateLimiter {
  private stamps: number[] = [];
  constructor(private max = 40, private windowMs = 60_000) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      const wait = this.stamps[0] + this.windowMs - now + 5;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}