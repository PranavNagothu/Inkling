import "server-only";

// Periodic reset of the public demo (DEMO_MODE). Every visitor is the same local student, so anyone
// can draw into Maya's seeded sessions and their own sessions show up for everyone (and feed Maya's
// gaps-over-time). Every DEMO_RESET_MINUTES, in the server process (started from instrumentation.ts):
//
//   1. visitor-uploaded lectures (PUBLIC_UPLOADS) older than DEMO_KEEP_VISITOR_MINUTES (default 60)
//      are deleted with every session on them, and their media files,
//   2. visitor sessions older than DEMO_KEEP_VISITOR_MINUTES are deleted, and
//   3. the demo is rebuilt exactly as `npm run seed:demo -- --reset` does (lib/demoSeed).
//
// Safety on SQLite (the Railway deploy): all steps run inside ONE transaction, so nothing is ever
// half-reset. Requests arriving meanwhile wait at the repository's gate (lib/db gateSqlite) for the
// few hundred ms it takes, instead of seeing missing sessions. The (student, lecture) lock is taken
// first, in the same order as every other writer (lib/gaps), so an analysis in flight finishes
// before the reset starts and none can deadlock with it. Replaced PDFs and removed lectures' media
// files are deleted after COMMIT.
// On Postgres the steps run without the outer transaction (a pooled client can't be shared that
// way); the deploy docs use SQLite.
import { LOCAL_STUDENT_ID, getDb, type Db } from "./db";
import { DEMO_LECTURE, DEMO_MEDIA_PATH } from "./demo";
import { isDemoMode } from "./demoMode";
import { allDemoSessionIds, seedDemo, unlinkAll } from "./demoSeed";
import { withLectureLock } from "./gaps";
import { resolveMediaPath, resolvePdfPath } from "./storage";

type Env = Record<string, string | undefined>;

const MINUTE = 60_000;
const DEFAULT_KEEP_VISITOR_MINUTES = 60;

const positive = (raw: string | undefined): number | null => {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Minutes between resets, or null (off). Only in DEMO_MODE, and only when DEMO_RESET_MINUTES is set
 * (scripts/start-prod.mjs defaults it to 30; `npm run demo` and the e2e servers leave it unset, so a
 * rehearsal on the laptop is never reset under the presenter). Floor: 3 seconds, for local checks.
 */
export function demoResetMinutes(env: Env): number | null {
  if (!isDemoMode(env)) return null;
  const n = positive(env.DEMO_RESET_MINUTES);
  return n === null ? null : Math.max(n, 0.05);
}

/** Visitor sessions younger than this survive a reset (0 = remove them all). */
export function keepVisitorMinutes(env: Env): number {
  const raw = env.DEMO_KEEP_VISITOR_MINUTES?.trim();
  if (!raw) return DEFAULT_KEEP_VISITOR_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KEEP_VISITOR_MINUTES;
}

export interface DemoResetResult {
  /** Visitor sessions deleted (not counting those removed with their lecture). */
  pruned: number;
  /** Visitor-uploaded lectures deleted. */
  lectures: number;
  ms: number;
}

const isOld = (createdAtIso: string, olderThanMs: number, now: number) => {
  const created = Date.parse(createdAtIso);
  return !(Number.isFinite(created) && now - created < olderThanMs);
};

/**
 * Visitor-uploaded lectures (PUBLIC_UPLOADS) older than the cut-off, with every session on them;
 * their media files are queued for removal after COMMIT. Never the bundled demo lecture, nor any
 * lecture one of Maya's seeded sessions is on.
 */
async function pruneVisitorLectures(db: Db, olderThanMs: number, now: number, files: string[]): Promise<number> {
  const demoSessions = new Set(allDemoSessionIds());
  const sessions = await db.listSessions();
  const protectedLectures = new Set([DEMO_LECTURE.lectureId]);
  for (const s of sessions) if (demoSessions.has(s.id)) protectedLectures.add(s.lectureId);
  let pruned = 0;
  for (const lecture of await db.listLectures()) {
    if (protectedLectures.has(lecture.id) || lecture.transcriptSource === "demo") continue;
    if (!isOld(lecture.createdAtIso, olderThanMs, now)) continue;
    for (const s of sessions) {
      if (s.lectureId !== lecture.id) continue;
      const { notabilityFiles } = await db.deleteSession(s.id);
      for (const name of notabilityFiles) {
        const abs = resolvePdfPath(name);
        if (abs) files.push(abs);
      }
    }
    const { deleted, mediaPath } = await db.deleteLecture(lecture.id);
    if (!deleted) continue;
    pruned++;
    const abs = mediaPath ? resolveMediaPath(mediaPath) : null;
    if (abs && abs !== resolveMediaPath(DEMO_MEDIA_PATH)) files.push(abs);
  }
  return pruned;
}

async function pruneVisitors(db: Db, olderThanMs: number, now: number, files: string[]): Promise<number> {
  const demo = new Set(allDemoSessionIds());
  let pruned = 0;
  for (const s of await db.listSessions()) {
    if (demo.has(s.id)) continue;
    const created = Date.parse(s.createdAtIso);
    if (Number.isFinite(created) && now - created < olderThanMs) continue;
    const { deleted, notabilityFiles } = await db.deleteSession(s.id);
    if (!deleted) continue;
    pruned++;
    for (const name of notabilityFiles) {
      const abs = resolvePdfPath(name);
      if (abs) files.push(abs);
    }
  }
  return pruned;
}

/** One reset (see the top of the file). Throws if the seed fails; on SQLite nothing is then changed. */
export async function resetDemo(env: Env = process.env, now: Date = new Date()): Promise<DemoResetResult> {
  const started = Date.now();
  const db = getDb();
  const files: string[] = [];
  const run = async () => {
    const keepMs = keepVisitorMinutes(env) * MINUTE;
    const lectures = await pruneVisitorLectures(db, keepMs, now.getTime(), files);
    const pruned = await pruneVisitors(db, keepMs, now.getTime(), files);
    await seedDemo({ reset: true, now, removedFiles: (removed) => files.push(...removed) });
    return { pruned, lectures };
  };
  const sqlite = (await db.info()).backend === "sqlite";
  const { pruned, lectures } = sqlite
    ? await withLectureLock(LOCAL_STUDENT_ID, DEMO_LECTURE.lectureId, () => db.transaction(() => run()))
    : await run();
  await unlinkAll(files);
  return { pruned, lectures, ms: Date.now() - started };
}

const g = globalThis as unknown as { __inklingDemoReset?: ReturnType<typeof setInterval> };

/** Starts the periodic reset once per process (no-op when off). Returns the interval in minutes. */
export function startDemoResetTimer(env: Env = process.env): number | null {
  const minutes = demoResetMinutes(env);
  if (minutes === null || g.__inklingDemoReset) return minutes;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { pruned, lectures, ms } = await resetDemo(env);
      console.log(
        `[inkling] demo reset in ${ms} ms (${pruned} visitor session${pruned === 1 ? "" : "s"}, ` +
          `${lectures} uploaded lecture${lectures === 1 ? "" : "s"} removed)`,
      );
    } catch (err) {
      console.error(`[inkling] demo reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  g.__inklingDemoReset = setInterval(() => void tick(), Math.round(minutes * MINUTE));
  g.__inklingDemoReset.unref?.();
  console.log(`[inkling] DEMO_MODE: the demo resets every ${minutes} min`);
  return minutes;
}
