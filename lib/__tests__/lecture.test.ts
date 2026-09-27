import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import demoTranscript from '../../public/demo/lecture.transcript.json';
import { SCENARIO_TIMES, buildPhase2Scenario } from '../../e2e/fixtures/phase2-scenario';
import { buildCorrectionScenario } from '../../e2e/fixtures/phase4-scenario';
import { scoreSession } from '../scoring';
import type { EraseEvent, Stroke, TranscriptWord } from '../types';

// Throwaway SQLite file, set before lib/db is first imported.
const dir = mkdtempSync(join(tmpdir(), 'inkling-lecture-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');

type Db = ReturnType<typeof import('../db')['getDb']>;
let db: Db;
let lectures: typeof import('../lecture');
let analyze: typeof import('../analyze');

beforeAll(async () => {
  db = (await import('../db')).getDb();
  lectures = await import('../lecture');
  analyze = await import('../analyze');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WORDS: TranscriptWord[] = [
  { w: 'related', startMs: 9000, endMs: 9600 },
  { w: 'rates', startMs: 9600, endMs: 10_000 },
  { w: 'ladder', startMs: 19_000, endMs: 19_500 },
  { w: 'slides', startMs: 20_000, endMs: 20_600 },
  { w: 'down', startMs: 31_000, endMs: 31_400 },
];

async function seed(lectureId: string, build: (id: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] }) {
  const s = await db.createSession({ lectureId, courseId: 'general', title: 't' });
  const { strokes, eraseEvents } = build(s.id);
  await db.upsertStrokes(s.id, strokes);
  await db.addEraseEvents(s.id, eraseEvents);
  return s.id;
}

describe('lectures table', () => {
  it('seeds the demo lecture on startup', async () => {
    const list = await lectures.listLectures();
    expect(list[0]).toMatchObject({
      id: 'demo-chain-rule',
      courseId: 'calc1',
      mediaType: 'audio',
      mime: 'audio/wav',
      durationMs: 360_000,
      transcriptSource: 'demo',
      wordCount: demoTranscript.length,
    });
    const rec = (await lectures.getLecture('demo-chain-rule'))!;
    expect(rec.words).toEqual(demoTranscript);
    expect(rec.mediaPath).toBe('public/demo/lecture.wav');
  });

  it('creates, lists (demo first, then newest) and re-transcribes lectures', async () => {
    const a = await db.createLecture({
      title: 'Older',
      courseId: 'general',
      mediaPath: 'data/uploads/a.wav',
      mediaType: 'audio',
      mime: 'audio/wav',
      durationMs: 40_000,
      words: [],
      transcriptSource: 'none',
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = await db.createLecture({
      title: 'Newer video',
      courseId: 'general',
      mediaPath: 'data/uploads/b.mp4',
      mediaType: 'video',
      mime: 'video/mp4',
      durationMs: 60_000,
      words: WORDS,
      transcriptSource: 'captions',
    });
    expect(b).toMatchObject({ mediaType: 'video', transcriptSource: 'captions', wordCount: WORDS.length });
    expect(b).not.toHaveProperty('mediaPath');

    const ids = (await lectures.listLectures()).map((l) => l.id);
    expect(ids.slice(0, 3)).toEqual(['demo-chain-rule', b.id, a.id]);

    const updated = await db.setLectureTranscript(a.id, WORDS, 'whisper');
    expect(updated).toMatchObject({ transcriptSource: 'whisper', wordCount: WORDS.length });
    expect((await lectures.getLecture(a.id))!.words).toEqual(WORDS);
    expect(await db.setLectureTranscript('nope', WORDS, 'whisper')).toBeNull();
    expect(await lectures.getLecture('nope')).toBeNull();
  });

  it('deletes an uploaded lecture (returning its media path) but never the demo lecture', async () => {
    const l = await db.createLecture({
      title: 'Temporary',
      courseId: 'general',
      mediaPath: 'data/uploads/tmp.wav',
      mediaType: 'audio',
      mime: 'audio/wav',
      durationMs: 1000,
      words: [],
      transcriptSource: 'none',
    });
    await db.setConceptLabel(l.id, `${l.id}@0`, 'Temporary concept');
    expect(await db.deleteLecture(l.id)).toEqual({ deleted: true, mediaPath: 'data/uploads/tmp.wav' });
    expect(await lectures.getLecture(l.id)).toBeNull();
    expect((await db.getConceptLabels(l.id)).size).toBe(0);
    expect(await db.deleteLecture(l.id)).toEqual({ deleted: false, mediaPath: null });
    expect(await db.deleteLecture('demo-chain-rule')).toEqual({ deleted: false, mediaPath: null });
    expect(await lectures.getLecture('demo-chain-rule')).not.toBeNull();
  });
});

describe('analysis uses the session’s lecture', () => {
  const upload = (words: TranscriptWord[]) =>
    db.createLecture({
      title: 'Related rates',
      courseId: 'general',
      mediaPath: 'data/uploads/x.wav',
      mediaType: 'audio',
      mime: 'audio/wav',
      durationMs: 40_000,
      words,
      transcriptSource: words.length ? 'captions' : 'none',
    });

  it('takes duration and transcript excerpts from the uploaded lecture', async () => {
    const lecture = await upload(WORDS);
    const id = await seed(lecture.id, (sid) => buildCorrectionScenario(sid, { eraseMs: 20_000 }));
    const result = (await analyze.analyzeSession(id))!;
    expect(result.durationMs).toBe(40_000);
    expect(result.windows).toHaveLength(4);
    const [event] = result.events;
    expect(event).toMatchObject({ type: 'misconception_corrected', lectureMs: 20_000 });
    expect(event.evidence).toEqual({ excerpt: 'related rates ladder slides down', audioStartMs: 10_000, audioEndMs: 30_000 });
  });

  it('a lecture without a transcript still analyses; excerpts are empty', async () => {
    const lecture = await upload([]);
    const id = await seed(lecture.id, (sid) => buildCorrectionScenario(sid, { eraseMs: 20_000 }));
    const result = (await analyze.analyzeSession(id))!;
    expect(result.durationMs).toBe(40_000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].evidence.excerpt).toBe('');
    const snapshot = (await analyze.getTimeline(id))!;
    expect(snapshot).toMatchObject({ analyzed: true, stale: false, durationMs: 40_000 });
  });

  it('falls back to the demo lecture for a session whose lecture row is gone', async () => {
    const id = await seed('deleted-lecture', (sid) => buildPhase2Scenario(sid, { gap: false }));
    const result = (await analyze.analyzeSession(id))!;
    expect(result.durationMs).toBe(360_000);
    expect(result.events[0].evidence.excerpt.length).toBeGreaterThan(0);
  });
});

describe('scoring without a transcript', () => {
  const { strokes, eraseEvents } = buildPhase2Scenario('s');
  const base = { sessionId: 's', strokes, eraseEvents, words: demoTranscript as TranscriptWord[], durationMs: 360_000 };

  it('disables the pause feature and shares its weight between slowdown and erase', () => {
    const withWords = scoreSession(base);
    const without = scoreSession({ ...base, hasTranscript: false });
    // With the transcript the gap window is a hesitation because the student paused while words were spoken.
    const gap = (ws: typeof withWords) => ws.find((w) => w.bucketStartMs === SCENARIO_TIMES.gapWindowMs)!;
    expect(gap(withWords).pause).toBeGreaterThan(0.4);
    expect(without.every((w) => w.pause === 0)).toBe(true);
    expect(without.every((w) => !w.reasons.some((r) => r.startsWith('paused')))).toBe(true);
    for (const w of without) {
      // Mouse input → pressure unusable → weights 0.3 / 0.25 renormalised over 0.55.
      expect(w.rawScore).toBeCloseTo((0.3 * w.slowdown + 0.25 * w.erase) / 0.55, 10);
    }
  });

  it('is unchanged when the flag is omitted or true', () => {
    expect(scoreSession({ ...base, hasTranscript: true })).toEqual(scoreSession(base));
  });
});
