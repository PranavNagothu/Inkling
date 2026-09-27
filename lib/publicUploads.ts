import "server-only";

// Rate limits for public lecture uploads (DEMO_MODE + PUBLIC_UPLOADS, see ./demoMode): at most
// PUBLIC_UPLOADS_PER_IP_PER_HOUR per client IP per sliding hour, and PUBLIC_UPLOAD_DAILY_CAP across
// all visitors per sliding day. In memory (one Next server, as on Railway); a restart clears them.
import { createRateLimiter } from "./ai/limits";

export const PUBLIC_UPLOADS_PER_IP_PER_HOUR = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface State {
  perIp: ReturnType<typeof createRateLimiter>;
  /** Accepted upload times within the last day (all visitors). */
  global: number[];
}

const g = globalThis as unknown as { __inklingPublicUploads?: State };
const state = (): State =>
  (g.__inklingPublicUploads ??= {
    perIp: createRateLimiter({ limit: PUBLIC_UPLOADS_PER_IP_PER_HOUR, windowMs: HOUR }),
    global: [],
  });

export type UploadSlot = { ok: true } | { ok: false; retryAfterMs: number; error: string };

/**
 * Counts one public upload for `ip`, or says why not. The global cap is checked first so a refused
 * request never uses one of the visitor's own slots.
 */
export function takePublicUploadSlot(ip: string, dailyCap: number, now: number = Date.now()): UploadSlot {
  const s = state();
  s.global = s.global.filter((t) => now - t < DAY);
  if (s.global.length >= dailyCap) {
    return {
      ok: false,
      retryAfterMs: Math.max(1000, s.global[0] + DAY - now),
      error: "The public demo has taken all the uploads it can for today. Try again tomorrow.",
    };
  }
  if (!s.perIp.take(ip)) {
    return {
      ok: false,
      retryAfterMs: Math.max(1000, s.perIp.retryAfterMs(ip)),
      error: `You can add up to ${PUBLIC_UPLOADS_PER_IP_PER_HOUR} lectures an hour on the public demo. Try again later.`,
    };
  }
  s.global.push(now);
  return { ok: true };
}

/** Forgets every count (tests). */
export function resetPublicUploadLimits(): void {
  delete g.__inklingPublicUploads;
}
