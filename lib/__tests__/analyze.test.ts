import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CORRECTED_WORD,
  SCENARIO_TIMES,
  buildPhase2Scenario,
  buildSteadyScenario,
} from '../../e2e/fixtures/phase2-scenario';
import { applyCheckAnswer, buildTimeline } from '../classify';
import type { ConfusionWindow, Revision, Stroke } from '../types';

// Point the repository at a throwaway SQLite file *before* lib/db is first imported.
const dir = mkdtempSync(join(tmpdir(), 'inkling-analyze-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');

type DbModule = typeof import('../db');
type AnalyzeModule = typeof import('../analyze');
let db: ReturnType<DbModule['getDb']>;
let analyze: AnalyzeModule;

beforeAll(async () => {
  db = (await import('../db')).getDb();
  analyze = await import('../analyze');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function seed(build: (id: string) => { strokes: Stroke[]; eraseEvents: import('../types').EraseEvent[] }) {
  const session = await db.createSession({ lectureId: 'demo-chain-rule', courseId: 'calc1', title: 'test' });
  const { strokes, eraseEvents } = build(session.id);
  await db.upsertStrokes(session.id, strokes);
  await db.addEraseEvents(session.id, eraseEvents);
  return session.id;
}

describe('analyzeSession', () => {
  it('returns null for an unknown session', async () => {
    expect(await analyze.analyzeSession('nope')).toBeNull();
    expect(await analyze.getTimeline('nope')).toBeNull();
  });

  it('turns an erase + rewrite in the same spot into a misconception_corrected event', async () => {
    const id = await seed((sid) => buildPhase2Scenario(sid, { gap: false }));
    const result = (await analyze.analyzeSession(id))!;

    // Covers the whole 6-minute lecture in 10 s windows; no hesitation spike without the gap.
    expect(result.durationMs).toBe(360_000);
    expect(result.windows).toHaveLength(36);
    expect(result.windows.some((w) => w.isSpike)).toBe(false);

    const corrections = result.revisions.filter((r) => r.kind === 'correction');
    expect(corrections).toHaveLength(1);
    const rev = corrections[0];
    expect(rev.lectureMs).toBe(SCENARIO_TIMES.correctionEraseMs);
    expect(rev.beforeStrokeIds).toEqual([`${id}-w${CORRECTED_WORD}-b`]);
    expect(rev.afterStrokeIds).toEqual([`${id}-rewrite`]);

    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event).toMatchObject({
      type: 'misconception_corrected',
      status: 'resolved',
      lectureMs: SCENARIO_TIMES.correctionEraseMs,
      revisionId: rev.id,
      checkAttempts: [],
    });
    // Phase 6: moments are tagged with the transcript sentence they happened in.
    expect(event.conceptId).toMatch(/^demo-chain-rule@\d+$/);
    expect(event.conceptLabel).toBeTruthy();
    expect(event.evidence.excerpt.length).toBeGreaterThan(20);
  });

  it('turns a hesitation burst after the baseline with no rewrite into an unresolved_gap', async () => {
    const id = await seed((sid) => buildPhase2Scenario(sid, { correction: false }));
    const result = (await analyze.analyzeSession(id))!;

    const spikes = result.windows.filter((w) => w.isSpike);
    expect(spikes.map((w) => w.bucketStartMs)).toEqual([SCENARIO_TIMES.gapWindowMs]);
    const reasons = spikes[0].reasons.join(' | ');
    expect(reasons).toMatch(/paused \d+s while \d+ words were spoken/);
    expect(reasons).toMatch(/erased 1×/);

    // The erased words were never rewritten: deletions, not corrections.
    expect(result.revisions.filter((r) => r.kind === 'correction')).toHaveLength(0);
    expect(result.revisions.filter((r) => r.kind === 'deletion')).toHaveLength(2);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: 'unresolved_gap',
      status: 'open',
      lectureMs: SCENARIO_TIMES.gapWindowMs,
      windowStartMs: SCENARIO_TIMES.gapWindowMs,
    });
    expect(result.events[0].revisionId).toBeUndefined();
  });

  it('a calm session produces no events', async () => {
    const id = await seed((sid) => buildSteadyScenario(sid));
    const result = (await analyze.analyzeSession(id))!;
    expect(result.events).toEqual([]);
    expect(result.revisions).toEqual([]);
  });

  it('persists the analysis and reports it via getTimeline (stale after new ink)', async () => {
    const id = await seed((sid) => buildPhase2Scenario(sid));
    const before = await analyze.getTimeline(id);
    expect(before).toMatchObject({ analyzed: false, events: [], durationMs: 360_000 });

    const result = (await analyze.analyzeSession(id))!;
    expect(result.events.map((e) => e.type)).toEqual(['misconception_corrected', 'unresolved_gap']);

    const stored = (await analyze.getTimeline(id))!;
    expect(stored.analyzed).toBe(true);
    expect(stored.stale).toBe(false);
    expect(stored.events).toEqual(result.events);
    expect(stored.revisions).toEqual(result.revisions);
    expect(stored.windows).toEqual(result.windows);

    const extra = buildSteadyScenario(`${id}-more`, 1).strokes.map((s) => ({ ...s, sessionId: id, startMs: 345_000 }));
    await db.upsertStrokes(id, extra);
    expect((await analyze.getTimeline(id))!.stale).toBe(true);
  });

  it('re-running is idempotent and preserves check attempts / status for unchanged event ids', async () => {
    const id = await seed((sid) => buildPhase2Scenario(sid));
    const first = (await analyze.analyzeSession(id))!;
    const corrected = first.events.find((e) => e.type === 'misconception_corrected')!;
    const gap = first.events.find((e) => e.type === 'unresolved_gap')!;

    // The student answers checks (Phase 5): a correct first answer turns the correction into a breakthrough.
    const answered = applyCheckAnswer(corrected, { atIso: '2026-09-25T12:00:00.000Z', choiceIdx: 1, correct: true });
    expect(answered.type).toBe('breakthrough');
    await db.updateEvent(answered);
    const gapAnswered = applyCheckAnswer(gap, { atIso: '2026-09-25T12:01:00.000Z', choiceIdx: 0, correct: true });
    await db.updateEvent(gapAnswered);

    const second = (await analyze.analyzeSession(id))!;
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(second.revisions).toEqual(first.revisions);
    expect(second.windows).toEqual(first.windows);

    const c2 = second.events.find((e) => e.id === corrected.id)!;
    expect(c2.type).toBe('breakthrough');
    expect(c2.status).toBe('resolved');
    expect(c2.checkAttempts).toEqual(answered.checkAttempts);
    const g2 = second.events.find((e) => e.id === gap.id)!;
    expect(g2.status).toBe('resolved');
    expect(g2.checkAttempts).toHaveLength(1);

    // Stored rows are replaced, not duplicated.
    const stored = (await analyze.getTimeline(id))!;
    expect(stored.events).toHaveLength(2);
    expect(stored.events.find((e) => e.id === corrected.id)!.checkAttempts).toHaveLength(1);
  });
});

describe('saving an analysis with two spikes near one correction', () => {
  const win = (sessionId: string, bucketStartMs: number, isSpike: boolean): ConfusionWindow => ({
    sessionId,
    bucketStartMs,
    pause: 0,
    slowdown: 0,
    erase: 0,
    pressure: null,
    rawScore: 0,
    emaScore: isSpike ? 0.7 : 0,
    isSpike,
    reasons: [],
    phase: 'scored',
  });
  const correction = (sessionId: string): Revision => ({
    id: `${sessionId}-r1`,
    sessionId,
    lectureMs: 95_000,
    beforeStrokeIds: [],
    afterStrokeIds: [],
    bbox: [0, 0, 1, 1],
    kind: 'correction',
  });

  it('stores every event (no duplicate primary key) and reads them back', async () => {
    const id = await seed(() => ({ strokes: [], eraseEvents: [] }));
    const windows = [win(id, 60_000, true), win(id, 100_000, true)];
    const revisions = [correction(id)];
    const events = buildTimeline({ sessionId: id, windows, revisions, words: [] });
    await expect(db.saveAnalysis(id, { durationMs: 200_000, windows, revisions, events, inkVersion: 0 })).resolves.toHaveLength(2);
    const stored = (await analyze.getTimeline(id))!;
    expect(stored.events.map((e) => e.type)).toEqual(['unresolved_gap', 'misconception_corrected']);
  });

  it('defensively drops a repeated event id instead of failing the whole analysis', async () => {
    const id = await seed(() => ({ strokes: [], eraseEvents: [] }));
    const windows = [win(id, 60_000, true)];
    const [event] = buildTimeline({ sessionId: id, windows, revisions: [], words: [] });
    const saved = await db.saveAnalysis(id, { durationMs: 200_000, windows, revisions: [], events: [event, { ...event }], inkVersion: 0 });
    expect(saved.map((e) => e.id)).toEqual([event.id]);
  });
});

describe('analysis exposes where the baseline was measured', () => {
  it('reports the baseline zones with the result and the stored snapshot', async () => {
    const id = await seed((sid) => buildPhase2Scenario(sid));
    const result = (await analyze.analyzeSession(id))!;
    // The scenario writes steadily from 1 s: the first 12 windows with ink are 0–120 s.
    expect(result.baseline).toEqual([{ startMs: 0, endMs: 120_000 }]);
    expect(result.windows.filter((w) => w.phase === 'baseline')).toHaveLength(12);
    expect((await analyze.getTimeline(id))!.baseline).toEqual(result.baseline);
  });

  it('follows a student who only starts writing later in the lecture', async () => {
    const id = await seed((sid) => {
      const { strokes } = buildSteadyScenario(sid, 60);
      return { strokes: strokes.map((s) => shift(s, 180_000)), eraseEvents: [] };
    });
    const result = (await analyze.analyzeSession(id))!;
    expect(result.baseline).toEqual([{ startMs: 180_000, endMs: 300_000 }]);
    expect(result.windows.filter((w) => w.bucketStartMs < 180_000).every((w) => w.phase === 'idle')).toBe(true);
  });
});

function shift(s: Stroke, dt: number): Stroke {
  return {
    ...s,
    startMs: s.startMs + dt,
    endMs: s.endMs + dt,
    points: s.points.map(([x, y, p, t]) => [x, y, p, t + dt] as Stroke['points'][number]),
  };
}
