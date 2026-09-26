import { describe, expect, it } from 'vitest';
import transcript from '../../public/demo/lecture.transcript.json';
import aiCache from '../../public/demo/ai-cache.json';
import { buildTimeline } from '../classify';
import { createConceptTagger } from '../concepts';
import { DEMO_TIMES, buildClassmate, buildMayaSession1, buildMayaSession2 } from '../demoScenario';
import { inkCounts } from '../ink';
import { pairRevisions } from '../pairing';
import { scoreSession } from '../scoring';
import type { TranscriptWord } from '../types';
import { isEraseEvent, isStroke } from '../validate';

const words = transcript as TranscriptWord[];
const DURATION = 360_000;

function analyse(sessionId: string, page: ReturnType<typeof buildMayaSession1>) {
  const windows = scoreSession({ sessionId, strokes: page.strokes, eraseEvents: page.eraseEvents, words, durationMs: DURATION });
  const revisions = pairRevisions({ sessionId, strokes: page.strokes, eraseEvents: page.eraseEvents });
  const tagger = createConceptTagger('demo-chain-rule', words);
  const events = buildTimeline({ sessionId, windows, revisions, words, conceptFor: tagger.conceptFor });
  return { windows, revisions, events };
}

const fixtureFor = (ms: number) => aiCache.entries.find((e) => ms >= e.fromMs && ms < e.toMs);

describe('demo scenario (Maya)', () => {
  const s1 = buildMayaSession1('demo-maya-1');

  it('is valid stored ink: every stroke and erase event passes the API validators', () => {
    expect(s1.strokes.every(isStroke)).toBe(true);
    expect(s1.eraseEvents.every(isEraseEvent)).toBe(true);
    expect(new Set(s1.strokes.map((s) => s.id)).size).toBe(s1.strokes.length);
    // Fits the notebook page at 1180×820 (two columns, above the fold).
    for (const s of s1.strokes) {
      expect(s.bbox[2]).toBeLessThan(830);
      expect(s.bbox[3]).toBeLessThan(600);
    }
    expect(inkCounts(s1.strokes).erasedParts).toBeGreaterThan(10);
  });

  it('session 1 analyses into the story: two corrections (01:02, 01:40) and one open gap (~04:10)', () => {
    const { events, revisions } = analyse('demo-maya-1', s1);
    expect(events.map((e) => [e.type, e.lectureMs])).toEqual([
      ['misconception_corrected', DEMO_TIMES.breakthroughEraseMs],
      ['misconception_corrected', DEMO_TIMES.correctionEraseMs],
      ['unresolved_gap', expect.any(Number)],
    ]);
    const gap = events[2];
    expect(gap.lectureMs).toBeGreaterThanOrEqual(DEMO_TIMES.gapFromMs);
    expect(gap.lectureMs).toBeLessThan(DEMO_TIMES.gapToMs);
    // The corrections pair the erased attempt with its rewrite.
    for (const e of events.slice(0, 2)) {
      const rev = revisions.find((r) => r.id === e.revisionId)!;
      expect(rev.kind).toBe('correction');
      expect(rev.beforeStrokeIds.length).toBeGreaterThan(3);
      expect(rev.afterStrokeIds.length).toBeGreaterThan(3);
    }
  });

  it('every seeded moment has hand-checked DEMO_MODE fixtures (help, and a reading for corrections)', () => {
    const { events } = analyse('demo-maya-1', s1);
    for (const e of events) {
      const entry = fixtureFor(e.lectureMs);
      expect(entry, `fixture for ${e.lectureMs}`).toBeDefined();
      if (e.type === 'misconception_corrected') expect(entry!.revision).toBeDefined();
    }
    expect(fixtureFor(DEMO_TIMES.correctionEraseMs)!.revision!.misconception).toMatch(/inner derivative/i);
  });

  it('session 2 is calm writing through the gap’s part of the lecture: no moments of its own', () => {
    const s2 = buildMayaSession2('demo-maya-2');
    expect(analyse('demo-maya-2', s2).events).toEqual([]);
    const through = s2.strokes.filter((s) => s.startMs >= 230_000 && s.startMs <= 270_000);
    expect(through.length).toBeGreaterThan(10);
  });

  it('classmates erase most in the lecture’s tricky parts', () => {
    const erasedAt = [0, 1, 2, 3, 4].flatMap((i) => buildClassmate(i).strokes.filter((s) => s.erased).map((s) => s.erasedAtMs!));
    expect(erasedAt.length).toBeGreaterThan(20);
    const inTricky = erasedAt.filter((t) => (t > 90_000 && t < 115_000) || (t > 245_000 && t < 275_000) || (t > 318_000 && t < 350_000));
    expect(inTricky.length).toBe(erasedAt.length);
  });
});
