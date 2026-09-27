// In-process async mutex keyed by string: tasks on one key run strictly one after another (in
// call order); different keys don't wait for each other. Used to serialise read → compute → write
// sequences that span awaits (lib/gaps: one student's gaps of one lecture). Single process only —
// a multi-instance deployment would need a database lock instead.
//
// Re-entrant per async context: a task that already holds a key (and everything it awaits) runs a
// nested run() on that key straight away instead of queueing behind itself, which would deadlock.
// The periodic demo reset (lib/demoReset) relies on this: it takes the lock, then a transaction,
// then re-analyses the demo sessions, which takes the same lock again. Work a task leaves running
// after it settles (fire-and-forget) does not keep the lock: a released hold no longer counts.
import { AsyncLocalStorage } from "node:async_hooks";

interface Hold {
  key: string;
  parent: Hold | undefined;
  released: boolean;
}

const holds = (h: Hold | undefined, key: string): boolean => {
  for (; h; h = h.parent) if (!h.released && h.key === key) return true;
  return false;
};

export interface KeyedMutex {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Keys with a running or queued task (for tests). */
  size(): number;
}

export function createKeyedMutex(): KeyedMutex {
  // Tail of each key's queue; removed when the last queued task settles.
  const tails = new Map<string, Promise<void>>();
  const held = new AsyncLocalStorage<Hold>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const outer = held.getStore();
      if (holds(outer, key)) return task();
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => (release = resolve));
      tails.set(key, tail);
      const hold: Hold = { key, parent: outer, released: false };
      return prev
        .then(() => held.run(hold, task))
        .finally(() => {
          hold.released = true;
          if (tails.get(key) === tail) tails.delete(key);
          release();
        });
    },
    size: () => tails.size,
  };
}
