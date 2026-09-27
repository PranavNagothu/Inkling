import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The periodic DEMO_MODE reset (lib/demoReset) on SQLite, through getDb(): it restores the seeded
// demo, prunes old visitor sessions, is atomic for concurrent readers and can't deadlock with an
// analysis holding the shared (student, lecture) lock.
const dir = mkdtempSync(join(tmpdir(), 'inkling-reset-'));
process.env.INKLING_DB_PATH = join(dir, 'reset.db');
process.env.INKLING_UPLOAD_DIR = join(dir, 'uploads');

let reset: typeof import('../demoReset');
let seed: typeof import('../demoSeed');
let analyze: typeof import('../analyze');
let db: ReturnType<typeof import('../db')['getDb']>;
const { DEMO_SESSIONS } = await import('../demoScenario');
const { DEMO_LECTURE } = await import('../demo');

const NOW = new Date('2026-09-27T06:00:00Z');
const HOUR = 3_600_000;
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);

beforeAll(async () => {
  reset = await import('../demoReset');
  seed = await import('../demoSeed');
  analyze = await import('../analyze');
  db = (await import('../db')).getDb();
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('demoResetMinutes / keepVisitorMinutes', () => {
  it('is on only in DEMO_MODE with DEMO_RESET_MINUTES set', () => {
    expect(reset.demoResetMinutes({})).toBeNull();
    expect(reset.demoResetMinutes({ DEMO_MODE: '1' })).toBeNull();
    expect(reset.demoResetMinutes({ DEMO_RESET_MINUTES: '30' })).toBeNull();
    expect(reset.demoResetMinutes({ DEMO_MODE: '1', DEMO_RESET_MINUTES: '30' })).toBe(30);
    expect(reset.demoResetMinutes({ DEMO_MODE: 'true', DEMO_RESET_MINUTES: ' 15 ' })).toBe(15);
    expect(reset.demoResetMinutes({ DEMO_MODE: '1', DEMO_RESET_MINUTES: '0' })).toBeNull();
    expect(reset.demoResetMinutes({ DEMO_MODE: '1', DEMO_RESET_MINUTES: 'soon' })).toBeNull();
    expect(reset.demoResetMinutes({ DEMO_MODE: '1', DEMO_RESET_MINUTES: '0.001' })).toBe(0.05);
  });

  it('keeps visitor sessions for 60 minutes by default', () => {
    expect(reset.keepVisitorMinutes({})).toBe(60);
    expect(reset.keepVisitorMinutes({ DEMO_KEEP_VISITOR_MINUTES: '0' })).toBe(0);
    expect(reset.keepVisitorMinutes({ DEMO_KEEP_VISITOR_MINUTES: '120' })).toBe(120);
    expect(reset.keepVisitorMinutes({ DEMO_KEEP_VISITOR_MINUTES: '-3' })).toBe(60);
  });
});

describe('resetDemo', () => {
  it('restores Maya’s sessions, prunes old visitor sessions and keeps one PDF', async () => {
    await seed.seedDemo({ now: new Date(NOW.getTime() - 5 * HOUR) });
    const seededStrokes = (await db.getStrokes(DEMO_SESSIONS.s1.id)).length;
    const seededEvents = (await db.getAnalysis(DEMO_SESSIONS.s1.id))!.events.map((e) => [e.type, e.status]);

    // A visitor draws into Maya's session and starts two sessions of their own.
    const [first] = await db.getStrokes(DEMO_SESSIONS.s1.id);
    await db.upsertStrokes(DEMO_SESSIONS.s1.id, [{ ...first, id: 'visitor-scribble' }]);
    expect((await db.getStrokes(DEMO_SESSIONS.s1.id)).length).toBe(seededStrokes + 1);
    const lecture = { lectureId: DEMO_LECTURE.lectureId, courseId: DEMO_LECTURE.courseId };
    await db.createSession({ id: 'visitor-old', title: 'Old visit', createdAtIso: new Date(NOW.getTime() - 3 * HOUR).toISOString(), ...lecture });
    await db.createSession({ id: 'visitor-new', title: 'New visit', createdAtIso: new Date(NOW.getTime() - 10 * 60_000).toISOString(), ...lecture });
    await db.upsertStrokes('visitor-new', [{ ...first, id: 'visitor-new-stroke' }]);

    // Concurrently: an analysis of the visitor's session (same student + lecture lock as Maya's)
    // and plain reads, which must never see the demo half-rebuilt.
    const resetting = reset.resetDemo({ DEMO_MODE: '1' }, NOW);
    const reads = Array.from({ length: 20 }, () => db.getSession(DEMO_SESSIONS.s1.id));
    const analysing = analyze.analyzeSession('visitor-new');
    const [result, sessions] = await within(Promise.all([resetting, Promise.all(reads), analysing]), 30_000);

    expect(sessions.every((s) => s?.id === DEMO_SESSIONS.s1.id)).toBe(true);
    expect(result.pruned).toBe(1);
    expect(await db.getSession('visitor-old')).toBeNull();
    expect(await db.getSession('visitor-new')).not.toBeNull();
    expect((await db.getStrokes(DEMO_SESSIONS.s1.id)).length).toBe(seededStrokes);
    expect((await db.getAnalysis(DEMO_SESSIONS.s1.id))!.events.map((e) => [e.type, e.status])).toEqual(seededEvents);
    // Session 1 was created "26 hours ago" relative to the reset.
    const s1 = (await db.getSession(DEMO_SESSIONS.s1.id))!;
    expect(NOW.getTime() - Date.parse(s1.createdAtIso)).toBe(26 * HOUR);
    // The Notability export was replaced, not duplicated.
    expect(readdirSync(join(dir, 'uploads', 'notability'))).toHaveLength(1);
  }, 60_000);

  it('can remove every visitor session and runs back to back', async () => {
    const first = await reset.resetDemo({ DEMO_MODE: '1', DEMO_KEEP_VISITOR_MINUTES: '0' }, NOW);
    expect(first.pruned).toBe(1);
    const again = await reset.resetDemo({ DEMO_MODE: '1', DEMO_KEEP_VISITOR_MINUTES: '0' }, NOW);
    expect(again.pruned).toBe(0);
    const ids = (await db.listSessions()).map((s) => s.id).sort();
    expect(ids).toEqual(seed.allDemoSessionIds().sort());
    expect(readdirSync(join(dir, 'uploads', 'notability'))).toHaveLength(1);
  }, 60_000);
});
