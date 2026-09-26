import { describe, expect, it } from 'vitest';
import {
  CONCEPT_CONFIG,
  bucketConcept,
  conceptLabel,
  createConceptTagger,
  segmentTranscript,
  withConceptLabels,
} from '../concepts';
import type { TranscriptWord } from '../types';

/** Words spaced 400 ms apart (300 ms long) starting at `t0`. */
function say(text: string, t0: number, step = 400): TranscriptWord[] {
  return text.split(' ').map((w, i) => ({ w, startMs: t0 + i * step, endMs: t0 + i * step + 300 }));
}

const LECTURE = 'lec1';

describe('segmentTranscript', () => {
  it('splits on sentence-ending punctuation', () => {
    const words = [...say('The chain rule is here.', 1000), ...say('Now we differentiate the outside.', 3000)];
    const segs = segmentTranscript(words);
    expect(segs.map((s) => s.text)).toEqual(['The chain rule is here.', 'Now we differentiate the outside.']);
    expect(segs[0]).toMatchObject({ startMs: 1000, endMs: 1000 + 4 * 400 + 300 });
    expect(segs[1].startMs).toBe(3000);
  });

  it('splits on a long silence even without punctuation (auto captions)', () => {
    const words = [...say('so this is the idea', 0), ...say('and then we move on', 10_000)];
    expect(segmentTranscript(words).map((s) => s.text)).toEqual(['so this is the idea', 'and then we move on']);
  });

  it('caps a run-on segment at maxSegmentMs', () => {
    // 100 words, 400 ms apart, no punctuation: 40 s of speech.
    const words = say(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' '), 0);
    const segs = segmentTranscript(words);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.endMs - s.startMs).toBeLessThanOrEqual(CONCEPT_CONFIG.maxSegmentMs);
    expect(segs.flatMap((s) => s.text.split(' '))).toHaveLength(100);
  });

  it('returns [] for no words', () => {
    expect(segmentTranscript([])).toEqual([]);
  });
});

describe('conceptLabel', () => {
  it('keeps the first ~8 words and marks truncation', () => {
    expect(conceptLabel('The chain rule tells us how to differentiate a composition of functions.')).toBe(
      'The chain rule tells us how to differentiate…',
    );
  });

  it('drops trailing punctuation on a short sentence', () => {
    expect(conceptLabel('Differentiate both sides.')).toBe('Differentiate both sides');
  });
});

describe('bucketConcept', () => {
  it('uses a 30 s bucket with a "Moment at mm:ss" label', () => {
    expect(bucketConcept(LECTURE, 221_000)).toEqual({
      id: 'lec1@210000',
      label: 'Moment at 03:30',
      startMs: 210_000,
      endMs: 240_000,
    });
  });
});

describe('createConceptTagger', () => {
  const words = [
    ...say('The chain rule is here.', 1000), // 1000–2900
    ...say('Now we differentiate the outside.', 3000), // 3000–4900
    ...say('Later on we multiply.', 20_000), // 20000–21500
  ];
  const tagger = createConceptTagger(LECTURE, words);

  it('tags a moment with the sentence containing it', () => {
    expect(tagger.conceptFor(3500)).toEqual({
      id: 'lec1@3000',
      label: 'Now we differentiate the outside',
      startMs: 3000,
      endMs: 4900,
    });
  });

  it('is stable: every moment inside one sentence gets the same id', () => {
    expect(tagger.conceptFor(3000).id).toBe(tagger.conceptFor(4800).id);
  });

  it('snaps a moment in a short silence to the sentence just before it', () => {
    expect(tagger.conceptFor(6000).id).toBe('lec1@3000');
  });

  it('falls back to a 30 s bucket far from any speech', () => {
    expect(tagger.conceptFor(12_000)).toEqual(bucketConcept(LECTURE, 12_000));
  });

  it('uses buckets for a lecture without a transcript', () => {
    const none = createConceptTagger(LECTURE, []);
    expect(none.conceptFor(95_000)).toEqual(bucketConcept(LECTURE, 95_000));
  });
});

describe('withConceptLabels (pluggable labels, e.g. AI in Phase 5)', () => {
  it('overrides labels by concept id and keeps ids and ranges', () => {
    const base = createConceptTagger(LECTURE, say('Now we differentiate the outside.', 3000));
    const labelled = withConceptLabels(base, (seg) => (seg.id === 'lec1@3000' ? 'Outer derivative' : null));
    expect(labelled.conceptFor(3200)).toMatchObject({ id: 'lec1@3000', label: 'Outer derivative', startMs: 3000 });
    // No override → the base label.
    expect(labelled.conceptFor(200_000).label).toBe('Moment at 03:00');
  });
});
