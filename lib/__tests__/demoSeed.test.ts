import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `npm run seed:demo` end to end, through getDb(): SQLite in the unit project, Postgres (PGlite) in
// the postgres project. Runs the app's real analysis / gaps / grading over the demo scenario.
const dir = mkdtempSync(join(tmpdir(), 'inkling-seed-'));
process.env.INKLING_DB_PATH = join(dir, 'seed.db');
process.env.INKLING_UPLOAD_DIR = join(dir, 'uploads');

let seed: typeof import('../demoSeed');
let db: ReturnType<typeof import('../db')['getDb']>;
let gaps: typeof import('../gaps');
let storage: typeof import('../storage');
const { DEMO_SESSIONS, DEMO_TIMES, DEMO_CLASSMATES, classmateSessionId } = await import('../demoScenario');

beforeAll(async () => {
  seed = await import('../demoSeed');
  db = (await import('../db')).getDb();
  gaps = await import('../gaps');
  storage = await import('../storage');
}, 60_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
});

describe('seedDemo', () => {
  let first: Awaited<ReturnType<typeof import('../demoSeed')['seedDemo']>>;

  it('seeds Maya’s two sessions: a breakthrough, the live correction and a gap resolved in session 2', async () => {
    first = await seed.seedDemo({ now: new Date('2026-09-26T18:00:00Z') });
    expect(first.status).toBe('seeded');
    const [s1, s2] = first.sessions;
    expect(s1.title).toBe('Maya — Session 1');
    expect(s1.moments.map((m) => [m.type, m.status])).toEqual([
      ['breakthrough', 'resolved'],
      ['misconception_corrected', 'resolved'],
      ['unresolved_gap', 'resolved'],
    ]);
    expect(s1.moments[1].lectureMs).toBe(DEMO_TIMES.correctionEraseMs);
    expect(s2).toMatchObject({ title: 'Maya — Session 2', moments: [] });

    const gap = (await db.getAnalysis(DEMO_SESSIONS.s1.id))!.events.find((e) => e.type === 'unresolved_gap')!;
    expect(gap).toMatchObject({ resolvedBy: 'revisit', resolvedInSessionId: DEMO_SESSIONS.s2.id, conceptLabel: 'Chain versus product rule' });

    const progress = await gaps.getProgress();
    const lecture = progress.lectures.find((l) => l.lectureId === 'demo-chain-rule')!;
    expect(lecture.threads).toHaveLength(1);
    expect(lecture.threads[0]).toMatchObject({ status: 'resolved', resolvedBy: 'revisit', label: 'Chain versus product rule' });
  }, 60_000);

  it('leaves the live moment for the demo: no reading or help yet, with fixtures ready in DEMO_MODE', async () => {
    const events = (await db.getAnalysis(DEMO_SESSIONS.s1.id))!.events;
    const live = events.find((e) => e.lectureMs === DEMO_TIMES.correctionEraseMs)!;
    expect(live.help).toBeUndefined();
    expect(live.checkAttempts).toEqual([]);
    expect((await db.getRevision(live.revisionId!))!.vision).toBeUndefined();
    const done = events.find((e) => e.type === 'breakthrough')!;
    expect(done.checkAttempts).toEqual([expect.objectContaining({ correct: true })]);
    expect((await db.getRevision(done.revisionId!))!.vision!.misconception).toMatch(/inner derivative/);
  });

  it('attaches a real one-page Notability PDF of the final page to session 1', async () => {
    const record = (await db.getNotabilityImport(DEMO_SESSIONS.s1.id))!;
    expect(record.import).toMatchObject({ fileName: seed.DEMO_PDF_NAME, pageCount: 1, current: true });
    const file = storage.resolvePdfPath(record.storedName)!;
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.byteLength).toBe(record.import.size);
    expect(bytes.byteLength).toBeLessThan(400_000);
  });

  it('stores classmates for the class-wide hotspots, outside the local student’s sessions', async () => {
    for (let i = 0; i < DEMO_CLASSMATES; i++) expect(await db.getSession(classmateSessionId(i))).not.toBeNull();
    const mine = await db.listStudentSessions('demo-student', 'demo-chain-rule');
    expect(mine.map((s) => s.id)).toEqual([DEMO_SESSIONS.s1.id, DEMO_SESSIONS.s2.id]);
    const hotspots = await db.lectureInkHotspots('demo-chain-rule');
    const erasedAt = (ms: number) => hotspots.find((h) => h.bucketStartMs === ms)?.erased ?? 0;
    expect(erasedAt(90_000)).toBeGreaterThan(erasedAt(30_000));
    expect(erasedAt(240_000)).toBeGreaterThan(erasedAt(180_000));
  });

  it('is idempotent, and --reset rebuilds only the demo', async () => {
    const other = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'calc1', title: 'my own notes' });
    const again = await seed.seedDemo();
    expect(again.status).toBe('already-seeded');
    expect(again.sessions).toEqual(first.sessions);

    const oldPdf = (await db.getNotabilityImport(DEMO_SESSIONS.s1.id))!.storedName;
    const reset = await seed.seedDemo({ reset: true });
    expect(reset.status).toBe('seeded');
    expect(reset.sessions.map((s) => s.moments.map((m) => m.type))).toEqual(first.sessions.map((s) => s.moments.map((m) => m.type)));
    expect(await db.getSession(other.id)).not.toBeNull();
    expect(existsSync(storage.resolvePdfPath(oldPdf)!)).toBe(false);
    expect(await db.listNotabilityImports(DEMO_SESSIONS.s1.id)).toHaveLength(1);
  }, 60_000);
});
