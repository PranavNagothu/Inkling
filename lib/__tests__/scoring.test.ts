import { describe, expect, it } from 'vitest';
import { SCORING_CONFIG, baselineRange, baselineZones, mad, median, percentile, robustZ, scoreSession } from '../scoring';
import type { BBox, ConfusionWindow, EraseEvent, Point, Stroke, TranscriptWord } from '../types';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function mkStroke(overrides: Partial<Stroke> = {}): Stroke {
  const startMs = overrides.startMs ?? 0;
  const endMs = overrides.endMs ?? startMs + 100;
  return {
    id: overrides.id ?? nextId('s'),
    sessionId: 'sess-1',
    startMs,
    endMs,
    points: [
      [0, 0, 0.5, startMs],
      [1, 1, 0.5, endMs],
    ] as Point[],
    pointerType: 'mouse',
    bbox: [0, 0, 1, 1] as BBox,
    inkLen: 1,
    medianSpeed: 1,
    erased: false,
    erasedAtMs: null,
    erasedBy: null,
    isScribble: false,
    ...overrides,
  };
}

function mkEraseEvent(overrides: Partial<EraseEvent> = {}): EraseEvent {
  return {
    id: nextId('ev'),
    sessionId: 'sess-1',
    atMs: 0,
    strokeIds: [],
    by: 'eraser',
    ...overrides,
  };
}

function mkWord(startMs: number, w = 'x'): TranscriptWord {
  return { w, startMs, endMs: startMs + 200 };
}

function wordsInRange(fromMs: number, count: number, stepMs = 500): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (let i = 0; i < count; i++) out.push(mkWord(fromMs + i * stepMs));
  return out;
}

function findWindow(windows: ConfusionWindow[], bucketStartMs: number): ConfusionWindow {
  const w = windows.find((win) => win.bucketStartMs === bucketStartMs);
  if (!w) throw new Error(`no window at ${bucketStartMs}`);
  return w;
}

describe('scoring helpers', () => {
  it('median computes the middle value(s) of a sorted array', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('mad computes the median absolute deviation', () => {
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
    expect(mad([])).toBe(0);
  });

  it('percentile computes the 90th percentile with linear interpolation', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 90)).toBeCloseTo(9.1, 5);
    expect(percentile([], 90)).toBe(0);
  });

  it('robustZ computes a standardized score from median and MAD', () => {
    const z = robustZ(9, 3, 1);
    expect(z).toBeCloseTo(4.047, 2);
    expect(robustZ(3, 3, 1)).toBe(0);
  });

  it('robustZ guards against a MAD of 0 without producing NaN or Infinity', () => {
    expect(robustZ(5, 5, 0)).toBe(0);
    const z = robustZ(6, 5, 0);
    expect(Number.isFinite(z)).toBe(true);
    expect(Number.isNaN(z)).toBe(false);
    expect(z).toBeGreaterThan(0);
  });
});

describe('scoreSession', () => {
  it('produces windows covering the whole duration with no spikes for a steady writer', () => {
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents: [],
      words: [],
      durationMs: 50000,
    });
    expect(windows).toHaveLength(5);
    expect(windows.map((w) => w.bucketStartMs)).toEqual([0, 10000, 20000, 30000, 40000]);
    for (const w of windows) {
      expect(w.pause).toBe(0);
      expect(w.slowdown).toBe(0);
      expect(w.erase).toBe(0);
      expect(w.pressure).toBeNull();
      expect(w.rawScore).toBe(0);
      expect(w.emaScore).toBe(0);
      expect(w.isSpike).toBe(false);
      expect(w.reasons).toEqual([]);
      expect(Number.isFinite(w.rawScore)).toBe(true);
      expect(Number.isFinite(w.emaScore)).toBe(true);
    }
  });

  it('flags exactly one spike with reasons for a pause+erase burst after baseline', () => {
    const words = wordsInRange(121000, 10);
    const eraseEvents = [
      mkEraseEvent({ atMs: 125000, by: 'eraser' }),
      mkEraseEvent({ atMs: 126000, by: 'eraser' }),
    ];
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents,
      words,
      durationMs: 140000,
      config: { emaAlpha: 1 },
    });

    const spikes = windows.filter((w) => w.isSpike);
    expect(spikes).toHaveLength(1);
    expect(spikes[0].bucketStartMs).toBe(120000);

    const burst = findWindow(windows, 120000);
    expect(burst.pause).toBe(1);
    expect(burst.erase).toBe(1);
    expect(burst.slowdown).toBe(0);
    expect(burst.pressure).toBeNull();
    expect(burst.reasons.some((r) => r.includes('paused'))).toBe(true);
    expect(burst.reasons.some((r) => r.includes('erased'))).toBe(true);
    expect(burst.reasons).toHaveLength(2);
  });

  it('ignores a pause when fewer than 8 words were spoken in the window', () => {
    const words = [mkWord(121000), mkWord(122000), mkWord(123000)];
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents: [],
      words,
      durationMs: 130000,
    });
    const w = findWindow(windows, 120000);
    expect(w.pause).toBe(0);
    expect(w.reasons.some((r) => r.includes('paused'))).toBe(false);
    expect(w.isSpike).toBe(false);
  });

  it('excludes undo events from the erase count', () => {
    const eraseEvents: EraseEvent[] = [];
    for (let i = 0; i < 12; i++) {
      if (i % 2 === 1) {
        eraseEvents.push(mkEraseEvent({ atMs: i * 10000 + 1000, by: 'eraser' }));
      }
    }
    eraseEvents.push(mkEraseEvent({ atMs: 121000, by: 'undo' }));
    eraseEvents.push(mkEraseEvent({ atMs: 122000, by: 'undo' }));
    eraseEvents.push(mkEraseEvent({ atMs: 123000, by: 'undo' }));

    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents,
      words: [],
      durationMs: 130000,
    });
    const w = findWindow(windows, 120000);
    expect(w.erase).toBe(0);
    expect(w.reasons.some((r) => r.includes('erased'))).toBe(false);
  });

  it('reports null pressure and redistributes weights for mouse input', () => {
    const strokes: Stroke[] = [];
    for (let i = 0; i < 12; i++) {
      strokes.push(mkStroke({ startMs: i * 10000, endMs: i * 10000 + 5000, pointerType: 'mouse' }));
    }
    const words = wordsInRange(121000, 10);
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes,
      eraseEvents: [],
      words,
      durationMs: 130000,
    });

    expect(windows.every((w) => w.pressure === null)).toBe(true);

    const w = findWindow(windows, 120000);
    expect(w.pause).toBe(1);
    expect(w.erase).toBe(0);
    expect(w.slowdown).toBe(0);
    expect(w.rawScore).toBeCloseTo(0.3 / 0.85, 5);
    expect(w.isSpike).toBe(false);
  });

  it('suppresses a spike that recurs within the refractory window (20s later) but allows one after it', () => {
    const words = [
      ...wordsInRange(121000, 15),
      ...wordsInRange(141000, 15),
      ...wordsInRange(201000, 15),
    ];
    const eraseEvents = [
      mkEraseEvent({ atMs: 125000, by: 'eraser' }),
      mkEraseEvent({ atMs: 145000, by: 'eraser' }),
      mkEraseEvent({ atMs: 205000, by: 'eraser' }),
    ];
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents,
      words,
      durationMs: 220000,
      config: { emaAlpha: 1 },
    });

    const first = findWindow(windows, 120000);
    const second = findWindow(windows, 140000);
    const third = findWindow(windows, 200000);

    expect(first.isSpike).toBe(true);
    expect(second.isSpike).toBe(false);
    expect(second.emaScore).toBeGreaterThanOrEqual(SCORING_CONFIG.spikeScore);
    expect(second.pause).toBeGreaterThanOrEqual(SCORING_CONFIG.featureOn);
    expect(second.erase).toBeGreaterThanOrEqual(SCORING_CONFIG.featureOn);
    expect(third.isSpike).toBe(true);
  });

  it('caps the number of spikes at maxSpikes, keeping the top 5 by emaScore', () => {
    const strokes: Stroke[] = [];
    const eraseEvents: EraseEvent[] = [];
    const words: TranscriptWord[] = [];

    for (let i = 0; i < 12; i++) {
      const t = i * 10000;
      strokes.push(mkStroke({ startMs: t + 100, endMs: t + 2100, medianSpeed: 10, pointerType: 'mouse' }));
      strokes.push(mkStroke({ startMs: t + 2200, endMs: t + 4200, medianSpeed: 10, pointerType: 'mouse' }));
    }

    const burstIdxs = [12, 17, 22, 27, 32, 37];
    const slowSpeeds = [0, 0.5, 1, 1.5, 2, 2.5]; // slowdown = 1, 0.95, 0.9, 0.85, 0.8, 0.75

    burstIdxs.forEach((idx, k) => {
      const t = idx * 10000;
      words.push(...wordsInRange(t + 1000, 10));
      eraseEvents.push(mkEraseEvent({ atMs: t + 9600, by: 'eraser' }));
      strokes.push(mkStroke({ startMs: t + 9000, endMs: t + 9200, medianSpeed: slowSpeeds[k], pointerType: 'mouse' }));
      strokes.push(mkStroke({ startMs: t + 9300, endMs: t + 9500, medianSpeed: slowSpeeds[k], pointerType: 'mouse' }));
    });

    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes,
      eraseEvents,
      words,
      durationMs: 390000,
      config: { emaAlpha: 1 },
    });

    const spikes = windows.filter((w) => w.isSpike);
    expect(spikes).toHaveLength(5);

    const strongestFive = burstIdxs.slice(0, 5).map((idx) => idx * 10000);
    const weakest = burstIdxs[5] * 10000;
    for (const bucketStartMs of strongestFive) {
      expect(findWindow(windows, bucketStartMs).isSpike).toBe(true);
    }
    expect(findWindow(windows, weakest).isSpike).toBe(false);
  });

  it('does not spike from a single elevated feature even when the (lowered) threshold is met', () => {
    const eraseEvents = [
      mkEraseEvent({ atMs: 121000, by: 'eraser' }),
      mkEraseEvent({ atMs: 122000, by: 'eraser' }),
      mkEraseEvent({ atMs: 123000, by: 'eraser' }),
    ];
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents,
      words: [],
      durationMs: 130000,
      config: { spikeScore: 0.2, emaAlpha: 1 },
    });
    const w = findWindow(windows, 120000);
    expect(w.erase).toBe(1);
    expect(w.emaScore).toBeGreaterThanOrEqual(0.2);
    expect(w.isSpike).toBe(false);
  });

  it('never marks a baseline window as a spike, even with an extreme signal', () => {
    const words = wordsInRange(1000, 10);
    const eraseEvents = [
      mkEraseEvent({ atMs: 2000, by: 'eraser' }),
      mkEraseEvent({ atMs: 3000, by: 'eraser' }),
      mkEraseEvent({ atMs: 4000, by: 'eraser' }),
      mkEraseEvent({ atMs: 5000, by: 'eraser' }),
      mkEraseEvent({ atMs: 6000, by: 'eraser' }),
    ];
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents,
      words,
      durationMs: 130000,
      config: { spikeScore: 0.01, emaAlpha: 1 },
    });
    const w = findWindow(windows, 0);
    expect(w.pause).toBe(1);
    expect(w.erase).toBe(1);
    expect(w.emaScore).toBeGreaterThan(0.5);
    expect(w.isSpike).toBe(false);
  });

  it('honors a config override (custom windowMs) for bucketing', () => {
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [],
      eraseEvents: [],
      words: [],
      durationMs: 20000,
      config: { windowMs: 5000 },
    });
    expect(windows).toHaveLength(4);
    expect(windows.map((w) => w.bucketStartMs)).toEqual([0, 5000, 10000, 15000]);
  });
});

// Phase 6: the baseline follows the student's own writing, not the lecture clock.
describe('scoreSession: baseline starts with the student', () => {
  const LECTURE_MS = 46 * 60_000; // a 46-minute lecture
  const START = 22 * 60_000 + 5_000; // the student starts writing at 22:05

  /** A word-like stroke every `periodMs` from `fromMs` (inclusive) to `toMs` (exclusive). */
  function steady(fromMs: number, toMs: number, periodMs = 2500, durMs = 1200): Stroke[] {
    const out: Stroke[] = [];
    for (let t = fromMs; t < toMs; t += periodMs) out.push(mkStroke({ startMs: t, endMs: t + durMs }));
    return out;
  }

  /** Lecturer speaks one word per second for the whole lecture. */
  const allWords = wordsInRange(0, LECTURE_MS / 1000, 1000);

  /** Mid-lecture session: steady writing from 22:05, a silent + erasing hesitation at 25:00, resume. */
  function midLecture() {
    const strokes = [...steady(START, START + 150_000), ...steady(1_530_000, 1_600_000)];
    const eraseEvents = [mkEraseEvent({ atMs: 1_500_500 }), mkEraseEvent({ atMs: 1_502_000 })];
    return { strokes, eraseEvents };
  }

  it('detects a hesitation burst in a session that starts at 22:05', () => {
    const { strokes, eraseEvents } = midLecture();
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes,
      eraseEvents,
      words: allWords,
      durationMs: LECTURE_MS,
      config: { emaAlpha: 1 },
    });
    expect(windows.filter((w) => w.isSpike).map((w) => w.bucketStartMs)).toEqual([1_500_000]);
    const burst = findWindow(windows, 1_500_000);
    expect(burst.pause).toBe(1);
    expect(burst.erase).toBe(1);
    expect(burst.phase).toBe('scored');
  });

  it('marks windows before the first stroke as idle: no features and never a spike', () => {
    const { strokes, eraseEvents } = midLecture();
    // Extreme signals before the student started (erasing is impossible without ink, but be safe).
    eraseEvents.push(mkEraseEvent({ atMs: 600_500 }), mkEraseEvent({ atMs: 601_000 }), mkEraseEvent({ atMs: 602_000 }));
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes,
      eraseEvents,
      words: allWords,
      durationMs: LECTURE_MS,
      config: { emaAlpha: 1, spikeScore: 0.01 },
    });
    const before = windows.filter((w) => w.bucketStartMs < 1_320_000);
    expect(before).toHaveLength(132);
    for (const w of before) {
      expect(w).toMatchObject({ phase: 'idle', pause: 0, slowdown: 0, erase: 0, rawScore: 0, emaScore: 0, isSpike: false });
      expect(w.reasons).toEqual([]);
    }
    // The bucket holding the first stroke opens the baseline.
    expect(findWindow(windows, 1_320_000).phase).toBe('baseline');
  });

  it('uses the first 120 s of writing as the baseline and exposes its range', () => {
    const { strokes, eraseEvents } = midLecture();
    const windows = scoreSession({ sessionId: 'sess-1', strokes, eraseEvents, words: allWords, durationMs: LECTURE_MS });
    const baseline = windows.filter((w) => w.phase === 'baseline').map((w) => w.bucketStartMs);
    expect(baseline).toHaveLength(12);
    expect(baseline[0]).toBe(1_320_000);
    expect(baseline[11]).toBe(1_430_000);
    expect(baselineRange(windows)).toEqual({ startMs: 1_320_000, endMs: 1_440_000 });
  });

  it('continues the baseline after a jump: the first 12 windows the student was active in', () => {
    // 30 s of notes at 10:00, then the student seeks to 30:00 and keeps writing.
    const strokes = [...steady(600_000, 630_000), ...steady(1_800_000, 2_000_000)];
    const windows = scoreSession({ sessionId: 'sess-1', strokes, eraseEvents: [], words: allWords, durationMs: LECTURE_MS });
    const baseline = windows.filter((w) => w.phase === 'baseline').map((w) => w.bucketStartMs);
    expect(baseline).toEqual([
      600_000, 610_000, 620_000,
      1_800_000, 1_810_000, 1_820_000, 1_830_000, 1_840_000, 1_850_000, 1_860_000, 1_870_000, 1_880_000,
    ]);
    // The stretch the student skipped is idle: it never contributes features or spikes.
    expect(findWindow(windows, 1_200_000)).toMatchObject({ phase: 'idle', pause: 0, rawScore: 0 });
    // And ink after the last activity (+ the activity gap) is idle too.
    expect(findWindow(windows, 2_700_000).phase).toBe('idle');
  });

  it('falls back gracefully when the student was active in fewer than 12 windows', () => {
    const strokes = steady(START, START + 25_000);
    const windows = scoreSession({ sessionId: 'sess-1', strokes, eraseEvents: [], words: allWords, durationMs: LECTURE_MS });
    expect(windows.filter((w) => w.phase === 'baseline').map((w) => w.bucketStartMs)).toEqual([1_320_000, 1_330_000, 1_340_000]);
    expect(windows.some((w) => w.isSpike)).toBe(false);
    expect(windows.every((w) => Number.isFinite(w.emaScore))).toBe(true);
  });

  it('ignores strokes removed with undo when finding where the student started', () => {
    const { strokes, eraseEvents } = midLecture();
    const undone = mkStroke({ startMs: 300_000, endMs: 301_000, erased: true, erasedAtMs: 301_500, erasedBy: 'undo' });
    const windows = scoreSession({
      sessionId: 'sess-1',
      strokes: [undone, ...strokes],
      eraseEvents,
      words: allWords,
      durationMs: LECTURE_MS,
    });
    expect(findWindow(windows, 300_000).phase).toBe('idle');
    expect(baselineRange(windows)?.startMs).toBe(1_320_000);
  });

  it('keeps the lecture-start baseline for a session that starts at 0 (unchanged behaviour)', () => {
    const strokes = steady(1000, 200_000);
    const windows = scoreSession({ sessionId: 'sess-1', strokes, eraseEvents: [], words: allWords, durationMs: 300_000 });
    expect(windows.filter((w) => w.phase === 'baseline').map((w) => w.bucketStartMs)).toEqual(
      Array.from({ length: 12 }, (_, i) => i * 10_000),
    );
    expect(baselineRange(windows)).toEqual({ startMs: 0, endMs: 120_000 });
  });

  it('without any ink falls back to the first 120 s of the lecture as the baseline', () => {
    const windows = scoreSession({ sessionId: 'sess-1', strokes: [], eraseEvents: [], words: [], durationMs: 200_000 });
    expect(baselineRange(windows)).toEqual({ startMs: 0, endMs: 120_000 });
    expect(windows.filter((w) => w.phase === 'idle')).toHaveLength(0);
  });

  it('baselineRange is null when no window carries a phase (analyses stored before Phase 6)', () => {
    const windows = scoreSession({ sessionId: 'sess-1', strokes: [], eraseEvents: [], words: [], durationMs: 50_000 });
    expect(baselineRange(windows.map(({ phase: _phase, ...w }) => w))).toBeNull();
  });
});

describe('baselineZones (the hatched Baseline on the review timeline)', () => {
  const steady = (fromMs: number, toMs: number) => {
    const out: Stroke[] = [];
    for (let t = fromMs; t < toMs; t += 2500) out.push(mkStroke({ startMs: t, endMs: t + 1200 }));
    return out;
  };

  it('is one zone for a student who writes continuously from mid-lecture', () => {
    const windows = scoreSession({ sessionId: 'sess-1', strokes: steady(1_325_000, 1_500_000), eraseEvents: [], words: [], durationMs: 2_760_000 });
    expect(baselineZones(windows, 2_760_000)).toEqual([{ startMs: 1_320_000, endMs: 1_440_000 }]);
  });

  it('splits into separate stretches when the student jumped ahead during the baseline', () => {
    const strokes = [...steady(600_000, 630_000), ...steady(1_800_000, 2_000_000)];
    const windows = scoreSession({ sessionId: 'sess-1', strokes, eraseEvents: [], words: [], durationMs: 2_760_000 });
    expect(baselineZones(windows, 2_760_000)).toEqual([
      { startMs: 600_000, endMs: 630_000 },
      { startMs: 1_800_000, endMs: 1_890_000 },
    ]);
  });

  it('is clipped to the track and empty before any analysis', () => {
    const windows = scoreSession({ sessionId: 'sess-1', strokes: steady(1000, 30_000), eraseEvents: [], words: [], durationMs: 35_000 });
    expect(baselineZones(windows, 35_000)).toEqual([{ startMs: 0, endMs: 30_000 }]);
    expect(baselineZones([], 35_000)).toEqual([]);
  });

  it('shows the lecture-start baseline for analyses stored before phases existed', () => {
    const windows = scoreSession({ sessionId: 'sess-1', strokes: [], eraseEvents: [], words: [], durationMs: 300_000 });
    const legacy = windows.map((w) => ({ ...w, phase: undefined }));
    expect(baselineZones(legacy, 300_000)).toEqual([{ startMs: 0, endMs: 120_000 }]);
  });
});
