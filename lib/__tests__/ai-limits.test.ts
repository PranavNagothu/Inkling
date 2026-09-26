import { describe, expect, it } from 'vitest';
import { createRateLimiter, createSemaphore, createSingleFlight } from '../ai/limits';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createSemaphore', () => {
  it('never runs more than `max` tasks at once and runs them all', async () => {
    const sem = createSemaphore(2);
    let running = 0;
    let peak = 0;
    const task = async (n: number) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      await tick();
      running--;
      return n;
    };
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => sem.run(() => task(n))));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(sem.active()).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('createRateLimiter', () => {
  it('allows `limit` takes per key within the window, then refuses until it slides', () => {
    let now = 0;
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    expect([rl.take('s1'), rl.take('s1'), rl.take('s1'), rl.take('s1')]).toEqual([true, true, true, false]);
    expect(rl.take('s2')).toBe(true); // per key
    now = 999;
    expect(rl.take('s1')).toBe(false);
    now = 1000;
    expect(rl.take('s1')).toBe(true);
  });

  it('reports when a refused key may retry', () => {
    let now = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    rl.take('k');
    now = 15_000;
    expect(rl.take('k')).toBe(false);
    expect(rl.retryAfterMs('k')).toBe(45_000);
  });
});

describe('createSingleFlight', () => {
  it('shares one in-flight promise per key and forgets it when settled', async () => {
    const sf = createSingleFlight();
    let calls = 0;
    const work = async () => {
      calls++;
      await tick();
      return calls;
    };
    const [a, b] = await Promise.all([sf.run('k', work), sf.run('k', work)]);
    expect([a, b]).toEqual([1, 1]);
    expect(await sf.run('k', work)).toBe(2);
  });
});
