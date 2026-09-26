import "server-only";

// Cost and load guards for provider calls (in-process; one Next server).
//   - semaphore: at most N provider calls in flight at once
//   - rate limiter: at most `limit` fresh generations per key (a session) per sliding window
//   - single flight: concurrent requests for the same result share one call

export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
  active(): number;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        waiting.push(() => {
          active++;
          resolve();
        });
      }
    });
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return {
    async run<T>(task: () => Promise<T>) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    active: () => active,
  };
}

export interface RateLimiter {
  /** Records a use and returns true when `key` is under its limit; false (nothing recorded) otherwise. */
  take(key: string): boolean;
  /** How long until `key` may take again (0 when it may now). */
  retryAfterMs(key: string): number;
}

export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  const recent = (key: string) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((at) => t - at < opts.windowMs);
    if (list.length === 0) hits.delete(key);
    else hits.set(key, list);
    return list;
  };
  return {
    take(key) {
      const list = recent(key);
      if (list.length >= opts.limit) return false;
      hits.set(key, [...list, now()]);
      return true;
    },
    retryAfterMs(key) {
      const list = recent(key);
      if (list.length < opts.limit) return 0;
      return Math.max(0, list[0] + opts.windowMs - now());
    },
  };
}

export interface SingleFlight {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createSingleFlight(): SingleFlight {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, task: () => Promise<T>) {
      const existing = inFlight.get(key);
      if (existing) return existing as Promise<T>;
      const p = task().finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
  };
}
