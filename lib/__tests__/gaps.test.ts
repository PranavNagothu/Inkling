import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAP_MS, buildCalmScenario, buildGapScenario, captionsFromWords } from '../../e2e/fixtures/phase6-scenario';
import { cuesToWords, parseCaptions } from '../captions';
import type { EraseEvent, Stroke, TimelineEvent } from '../types';

// Integration: analysis → cross-session gap resolution → progress, on a throwaway SQLite file.
const dir = mkdtempSync(join(tmpdir(), 'inkling-gaps-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');

let db: ReturnType<typeof import('../db')['getDb']>;
let analyze: typeof import('../analyze');
let gaps: typeof import('../gaps');

const DEMO = 'demo-chain-rule';

beforeAll(async () => {
  db = (await import('../db')).getDb();
  analyze = await import('../analyze');
  gaps = await import('../gaps');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Build = (id: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] };

async function run(studentId: string, build: Build, lectureId = DEMO) {
  const session = await db.createSession({ lectureId, courseId: 'calc1', title: 't', studentId });
  const { strokes, eraseEvents } = build(session.id);
  await db.upsertStrokes(session.id, strokes);
  await db.addEraseEvents(session.id, eraseEvents);
  const result = (await analyze.analyzeSession(session.id))!;
  return { id: session.id, events: result.events };
}

const calm: Build = (id) => buildCalmScenario(id, { fromMs: 150_000, toMs: 270_000 });

async function storedGap(sessionId: string): Promise<TimelineEvent> {
  const t = (await analyze.getTimeline(sessionId))!;
  const g = t.events.find((e) => e.type === 'unresolved_gap');
  if (!g) throw new Error('no gap');
  return g;
}

describe('concepts on analysed events', () => {
  it('tags a gap with its transcript sentence and a readable label', async () => {
    const s1 = await run('st-concept', buildGapScenario);
    const [g] = s1.events;
    expect(g.type).toBe('unresolved_gap');
    expect(g.lectureMs).toBe(GAP_MS);
    expect(g.conceptId).toMatch(/^demo-chain-rule@\d+$/);
    const segStart = Number(g.conceptId!.split('@')[1]);
    expect(segStart).toBeLessThanOrEqual(GAP_MS + 3000);
    expect(g.conceptLabel).toBeTruthy();
    expect(g.conceptLabel!.split(' ').length).toBeLessThanOrEqual(8);
    expect(g.history).toMatchObject({ occurrence: 1, occurrences: 1, threadStatus: 'open' });
  });
});

describe('captioned lecture (what e2e/phase6 uploads)', () => {
  it('the gap scenario yields one sentence-tagged gap at 03:40, and a calm mid-lecture session resolves it', async () => {
    const words = cuesToWords(parseCaptions(captionsFromWords((await db.getLecture(DEMO))!.words)));
    const lecture = await db.createLecture({
      title: 'Captioned demo',
      courseId: 'general',
      mediaPath: 'public/demo/lecture.wav',
      mediaType: 'audio',
      mime: 'audio/wav',
      durationMs: 360_000,
      words,
      transcriptSource: 'captions',
    });
    const s1 = await run('st-captions', buildGapScenario, lecture.id);
    expect(s1.events.map((e) => [e.type, e.lectureMs])).toEqual([['unresolved_gap', GAP_MS]]);
    expect(s1.events[0].conceptId).toMatch(new RegExp(`^${lecture.id}@\\d+$`));
    const s2 = await run('st-captions', calm, lecture.id);
    expect(s2.events).toEqual([]);
    expect((await storedGap(s1.id)).status).toBe('resolved');
  });
});

describe('revisit across sessions', () => {
  it('a later calm session over the segment resolves the earlier gap (and re-analysis is stable)', async () => {
    const s1 = await run('st-revisit', buildGapScenario);
    const s2 = await run('st-revisit', calm);
    expect(s2.events).toEqual([]);

    const g1 = await storedGap(s1.id);
    expect(g1).toMatchObject({ status: 'resolved', resolvedBy: 'revisit', resolvedInSessionId: s2.id });
    const s2Session = (await db.getSession(s2.id))!;
    expect(g1.resolvedAtIso).toBe(s2Session.createdAtIso);

    // Re-analysing either session changes nothing.
    await analyze.analyzeSession(s2.id);
    await analyze.analyzeSession(s1.id);
    await analyze.analyzeSession(s2.id);
    expect(await storedGap(s1.id)).toEqual(g1);
  });

  it('is scoped to the same lecture and the same student', async () => {
    const other = await db.createLecture({
      title: 'Copy of the demo',
      courseId: 'calc1',
      mediaPath: 'public/demo/lecture.wav',
      mediaType: 'audio',
      mime: 'audio/wav',
      durationMs: 360_000,
      words: (await db.getLecture(DEMO))!.words,
      transcriptSource: 'captions',
    });
    const s1 = await run('st-scope', buildGapScenario);
    await run('st-scope', calm, other.id); // same student, other lecture
    await run('st-someone-else', calm); // other student, same lecture
    expect((await storedGap(s1.id)).status).toBe('open');
  });

  it('a repeat gap keeps the thread open and links to the earlier gap ("2nd time")', async () => {
    const s1 = await run('st-repeat', buildGapScenario);
    const s2 = await run('st-repeat', buildGapScenario);
    const g1 = await storedGap(s1.id);
    const g2 = await storedGap(s2.id);
    expect(g1.status).toBe('open');
    expect(g2).toMatchObject({ status: 'open', repeatOf: g1.id });
    expect(g2.history).toMatchObject({ occurrence: 2, occurrences: 2, threadStatus: 'open' });

    const progress = await gaps.getProgress('st-repeat');
    expect(progress.openCount).toBe(1);
    const [thread] = progress.lectures[0].threads;
    expect(thread).toMatchObject({ status: 'open', occurrences: 2 });
    expect(thread.latest.eventId).toBe(g2.id);
  });
});

describe('self resolution', () => {
  it('"I get it now" persists through re-analysis; "Still confused" reopens', async () => {
    const s1 = await run('st-self', buildGapScenario);
    const g1 = await storedGap(s1.id);

    const res = await gaps.selfResolveGap(g1.id, 'self');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.map((e) => [e.id, e.status, e.resolvedBy])).toEqual([[g1.id, 'resolved', 'self']]);

    await analyze.analyzeSession(s1.id);
    expect(await storedGap(s1.id)).toMatchObject({ status: 'resolved', resolvedBy: 'self' });

    const reopened = await gaps.selfResolveGap(g1.id, 'reopen');
    expect(reopened.ok && reopened.events[0].status).toBe('open');
    const after = await storedGap(s1.id);
    expect(after.status).toBe('open');
    expect(after.reopenedAtIso).toBeTruthy();
    expect(after.resolvedBy).toBeUndefined();
  });

  it('rejects unknown ids and non-gaps', async () => {
    expect(await gaps.selfResolveGap('nope', 'self')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('open gaps for a lecture', () => {
  it('lists earlier open threads (for the capture banner) and what a session carried over', async () => {
    const s1 = await run('st-open', buildGapScenario);
    const g1 = await storedGap(s1.id);
    const s2 = await db.createSession({ lectureId: DEMO, courseId: 'calc1', title: 't', studentId: 'st-open' });

    const before = await gaps.getLectureGaps(DEMO, { sessionId: s2.id });
    expect(before.open.map((t) => t.latest.eventId)).toEqual([g1.id]);
    expect(before.open[0].seekMs).toBeLessThanOrEqual(GAP_MS);
    expect(before.open[0].seekMs).toBeGreaterThan(GAP_MS - 30_000);
    expect(before.carried.map((c) => c.here)).toEqual(['open']);

    const { strokes } = calm(s2.id);
    await db.upsertStrokes(s2.id, strokes);
    await analyze.analyzeSession(s2.id);
    const after = await gaps.getLectureGaps(DEMO, { sessionId: s2.id });
    expect(after.open).toEqual([]);
    expect(after.carried).toHaveLength(1);
    expect(after.carried[0]).toMatchObject({ here: 'resolved', resolvedBy: 'revisit' });

    const progress = await gaps.getProgress('st-open');
    expect(progress.openCount).toBe(0);
    expect(progress.lectures[0].threads[0]).toMatchObject({ status: 'resolved', resolvedBy: 'revisit', resolvedInSessionId: s2.id });
  });
});

describe('concurrency (per student + lecture lock)', () => {
  /** A student's gaps, with ids replaced by session order so two students can be compared. */
  async function shape(studentId: string) {
    const sessions = await db.listStudentSessions(studentId, DEMO);
    const index = new Map(sessions.map((s, i) => [s.id, i]));
    const list = await db.listGaps(studentId, DEMO);
    const gapIndex = new Map(list.map((g, i) => [g.id, i]));
    return list.map((g) => ({
      session: index.get(g.sessionId),
      lectureMs: g.lectureMs,
      status: g.status,
      resolvedBy: g.resolvedBy ?? null,
      resolvedIn: g.resolvedInSessionId ? index.get(g.resolvedInSessionId) : null,
      repeatOf: g.repeatOf ? gapIndex.get(g.repeatOf) : null,
      attempts: g.checkAttempts.length,
    }));
  }

  async function seed(studentId: string, builds: Build[]) {
    const ids: string[] = [];
    for (const build of builds) {
      const session = await db.createSession({ lectureId: DEMO, courseId: 'calc1', title: 't', studentId });
      const { strokes, eraseEvents } = build(session.id);
      await db.upsertStrokes(session.id, strokes);
      await db.addEraseEvents(session.id, eraseEvents);
      ids.push(session.id);
    }
    return ids;
  }

  it('analysing sessions in parallel ends in the same state as analysing them one by one', async () => {
    const builds: Build[] = [buildGapScenario, buildGapScenario, calm];
    const sequential = await seed('st-seq', builds);
    for (const id of sequential) await analyze.analyzeSession(id);
    const parallel = await seed('st-par', builds);
    await Promise.all([...parallel].reverse().map((id) => analyze.analyzeSession(id)));
    // And once more, all at once, mixed with re-analysis.
    await Promise.all([...parallel, ...parallel].map((id) => analyze.analyzeSession(id)));
    expect(await shape('st-par')).toEqual(await shape('st-seq'));
    expect((await shape('st-seq')).length).toBe(2);
  });

  it('a wrong check answer racing a revisit-resolving analysis is never lost', async () => {
    const [s1, s2] = await seed('st-race', [buildGapScenario, calm]);
    await analyze.analyzeSession(s1);
    const g1 = await storedGap(s1);
    await db.setEventHelp(g1.id, {
      reexplain: 'r',
      mcq: { q: 'q', options: ['a', 'b', 'c', 'd'], answerIdx: 2, why: 'w' },
    });
    const [, answered] = await Promise.all([analyze.analyzeSession(s2), gaps.answerCheckQuestion(g1.id, 0)]);
    expect(answered).toMatchObject({ ok: true, correct: false });
    // Either order gives the same result: the answer came after session 2 started, so session 2's
    // calm writing can't resolve it (reopenedAtIso), and the attempt is kept.
    const after = await storedGap(s1);
    expect(after.status).toBe('open');
    expect(after.checkAttempts).toHaveLength(1);
    expect(after.reopenedAtIso).toBeTruthy();
    expect((await db.getEvent(g1.id))!.help?.mcq.answerIdx).toBe(2);
  });

  it('answerCheckQuestion: a correct answer resolves the gap by check and survives re-analysis', async () => {
    const [s1] = await seed('st-check', [buildGapScenario]);
    await analyze.analyzeSession(s1);
    const g1 = await storedGap(s1);
    expect(await gaps.answerCheckQuestion(g1.id, 1)).toMatchObject({ ok: false, status: 409 });
    await db.setEventHelp(g1.id, {
      reexplain: 'r',
      mcq: { q: 'q', options: ['a', 'b', 'c', 'd'], answerIdx: 1, why: 'w' },
    });
    const wrong = await gaps.answerCheckQuestion(g1.id, 3);
    expect(wrong).toMatchObject({ ok: true, correct: false, why: 'w' });
    const right = await gaps.answerCheckQuestion(g1.id, 1);
    expect(right).toMatchObject({ ok: true, correct: true, answerIdx: 1 });
    if (!right.ok) return;
    expect(right.event).toMatchObject({ status: 'resolved', resolvedBy: 'check' });
    expect(right.event.help).toBeUndefined(); // never sent to the client
    await analyze.analyzeSession(s1);
    expect(await storedGap(s1)).toMatchObject({ status: 'resolved', resolvedBy: 'check' });
    const progress = await gaps.getProgress('st-check');
    expect(progress.lectures[0].threads[0]).toMatchObject({ status: 'resolved', resolvedBy: 'check' });
    expect(await gaps.answerCheckQuestion('nope', 0)).toMatchObject({ ok: false, status: 404 });
  });
});
