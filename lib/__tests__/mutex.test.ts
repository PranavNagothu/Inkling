import { describe, expect, it } from 'vitest';
import { createKeyedMutex } from '../mutex';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createKeyedMutex', () => {
  it('runs tasks on the same key one at a time, in call order', async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      await tick();
      log.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([mutex.run('k', task('a')), mutex.run('k', task('b')), mutex.run('k', task('c'))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('lets different keys run concurrently', async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([mutex.run('x', task('x')), mutex.run('y', task('y'))]);
    expect(log.slice(0, 2).sort()).toEqual(['x:start', 'y:start']);
  });

  it('a failing task releases the lock and its error reaches only its caller', async () => {
    const mutex = createKeyedMutex();
    const failed = mutex.run('k', async () => {
      throw new Error('boom');
    });
    const next = mutex.run('k', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('forgets idle keys (no unbounded growth)', async () => {
    const mutex = createKeyedMutex();
    await mutex.run('a', async () => 1);
    await mutex.run('b', async () => 2);
    expect(mutex.size()).toBe(0);
  });
  it('is re-entrant within the task holding the key (no self-deadlock), still exclusive for others', async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const outer = mutex.run('k', async () => {
      log.push('outer:start');
      await tick();
      // Nested on the same key: runs now instead of queueing behind itself.
      const inner = await mutex.run('k', async () => {
        await tick();
        log.push('inner');
        return 'inner';
      });
      await tick();
      log.push('outer:end');
      return inner;
    });
    const other = mutex.run('k', async () => {
      log.push('other');
    });
    expect(await outer).toBe('inner');
    await other;
    expect(log).toEqual(['outer:start', 'inner', 'outer:end', 'other']);
  });

  it('does not let work left running after a task settles bypass the lock', async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    let late!: Promise<void>;
    let fired!: () => void;
    const timerFired = new Promise<void>((r) => (fired = r));
    await mutex.run('k', async () => {
      // Fire-and-forget: this callback inherits the task's async context but runs after it settles.
      setTimeout(() => {
        late = mutex.run('k', async () => void log.push('late'));
        fired();
      }, 5);
    });
    let releaseBlocker!: () => void;
    const blocker = mutex.run('k', () => new Promise<void>((r) => (releaseBlocker = r)).then(() => void log.push('blocker')));
    await timerFired;
    await tick();
    expect(log).toEqual([]); // queued behind the blocker, not re-entered
    releaseBlocker();
    await Promise.all([blocker, late]);
    expect(log).toEqual(['blocker', 'late']);
  });
});
