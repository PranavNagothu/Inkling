import "server-only";

// The public demo on Vercel (VERCEL=1, DEMO_MODE=1). A Vercel function has no persistent disk: the
// project folder is read-only and /tmp is private to one instance and gone when it recycles. So each
// instance keeps its own throwaway SQLite database under /tmp/inkling (lib/paths) and seeds the demo
// into it at cold start, from instrumentation.ts, before the first request is served. It is the same
// seed as `npm run seed:demo` (lib/demoSeed), including Maya's Notability PDF, which is written to
// <data>/uploads/notability in /tmp.
//
// Idempotent (seedDemo does nothing when the demo is complete) and concurrency-safe per instance:
// one promise per process, so parallel callers wait for the same seed. No periodic reset
// (lib/demoReset is off on Vercel): a fresh instance starts from a fresh demo anyway.
import { isDemoMode } from "./demoMode";
import { seedDemo } from "./demoSeed";
import { dbPathSetting, onVercel } from "./paths";

type Env = Record<string, string | undefined>;

const g = globalThis as unknown as { __inklingVercelSeed?: Promise<void> };

/** Seed on this platform? Only on Vercel, in DEMO_MODE, with SQLite (no DATABASE_URL). */
export function shouldSeedOnVercel(env: Env = process.env): boolean {
  return onVercel(env) && isDemoMode(env) && !env.DATABASE_URL?.trim();
}

/** Seeds the demo into this instance's database once. Never throws: failures are logged. */
export function ensureVercelDemo(env: Env = process.env): Promise<void> {
  if (!shouldSeedOnVercel(env)) return Promise.resolve();
  g.__inklingVercelSeed ??= (async () => {
    const started = Date.now();
    try {
      const { status } = await seedDemo();
      console.log(`[inkling] Vercel demo ${status} in ${Date.now() - started} ms (SQLite at ${dbPathSetting(env)})`);
    } catch (err) {
      // Let a later call try again rather than serving a half-seeded demo for the instance's lifetime.
      g.__inklingVercelSeed = undefined;
      console.error(`[inkling] Vercel demo seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return g.__inklingVercelSeed;
}
