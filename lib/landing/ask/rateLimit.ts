// In-memory rate limiting for the assistant: per-IP (per minute and per day) plus a global daily
// cap on model calls. Memory only — on a serverless host each instance keeps its own counts,
// which is fine as a cost guard (the provider's own limits are the backstop).
//
// The clock is injectable so tests don't wait.

export interface RateLimitConfig {
  perMinute: number;
  perDay: number;
  globalPerDay: number;
  /** Tracked IPs before old entries are swept (bounds memory under a flood of spoofed IPs). */
  maxKeys?: number;
}

export type LimitResult = { ok: true } | { ok: false; reason: "minute" | "day" | "global" };

interface Bucket {
  /** Request times in the last minute (ms). */
  minute: number[];
  dayStart: number;
  dayCount: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private globalDayStart: number;
  private globalCount = 0;
  private readonly maxKeys: number;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.globalDayStart = now();
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  /** Check the limits for `key` and, when allowed, count this request. */
  take(key: string): LimitResult {
    const t = this.now();

    if (t - this.globalDayStart >= DAY) {
      this.globalDayStart = t;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.config.globalPerDay) return { ok: false, reason: "global" };

    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { minute: [], dayStart: t, dayCount: 0 };
      this.buckets.set(key, b);
    }
    if (t - b.dayStart >= DAY) {
      b.dayStart = t;
      b.dayCount = 0;
    }
    b.minute = b.minute.filter((x) => t - x < MINUTE);

    if (b.dayCount >= this.config.perDay) return { ok: false, reason: "day" };
    if (b.minute.length >= this.config.perMinute) return { ok: false, reason: "minute" };

    b.minute.push(t);
    b.dayCount += 1;
    this.globalCount += 1;
    return { ok: true };
  }

  /** Tracked keys (for tests). */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(t: number) {
    for (const [k, b] of this.buckets) {
      if (t - b.dayStart >= DAY || (b.dayCount === 0 && b.minute.length === 0)) this.buckets.delete(k);
    }
    // Still full (a flood of fresh keys): drop the oldest half. Map keeps insertion order.
    if (this.buckets.size >= this.maxKeys) {
      let drop = Math.ceil(this.buckets.size / 2);
      for (const k of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(k);
      }
    }
  }
}

/** A positive integer from an env var, or the fallback. */
export function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
