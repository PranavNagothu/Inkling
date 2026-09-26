// In-process async mutex keyed by string: tasks on one key run strictly one after another (in
// call order); different keys don't wait for each other. Used to serialise read → compute → write
// sequences that span awaits (lib/gaps: one student's gaps of one lecture). Single process only —
// a multi-instance deployment would need a database lock instead.

export interface KeyedMutex {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Keys with a running or queued task (for tests). */
  size(): number;
}

export function createKeyedMutex(): KeyedMutex {
  // Tail of each key's queue; removed when the last queued task settles.
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => (release = resolve));
      tails.set(key, tail);
      return prev.then(task).finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
        release();
      });
    },
    size: () => tails.size,
  };
}
