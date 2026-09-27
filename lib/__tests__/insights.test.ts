import { describe, expect, it } from 'vitest';
import transcript from '../../public/demo/lecture.transcript.json';
import { buildTimeline } from '../classify';
import { createConceptTagger } from '../concepts';
import { buildMayaSession1 } from '../demoScenario';
import { FEATURES, describePoint, formatScore, reviewHref, shapeSignalLab, timeTicks } from '../insights';
import { pairRevisions } from '../pairing';
import { SCORING_CONFIG, baselineZones, scoreSession } from '../scoring';
import type { ConfusionWindow, TimelineEvent, TranscriptWord } from '../types';

function win(bucketStartMs: number, over: Partial<ConfusionWindow> = {}): ConfusionWindow {
  return {
    sessionId: 's',
    bucketStartMs,
    pause: 0,
    slowdown: 0,
    erase: 0,
    pressure: null,
    rawScore: 0,
    emaScore: 0,
    isSpike: false,
    reasons: [],
    phase: 'scored',
    ...over,
  };
}

function event(id: string, lectureMs: number, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id,
    sessionId: 's',
    lectureMs,
    type: 'unresolved_gap',
    status: 'open',
    conceptId: null,
    evidence: { excerpt: '', audioStartMs: 0, audioEndMs: 0 },
    checkAttempts: [],
    ...over,
  };
}

describe('shapeSignalLab', () => {
  it('empty timeline: no points, no peak, the shipped thresholds', () => {
    const d = shapeSignalLab({ durationMs: 0, windows: [], events: [], baseline: [] });
    expect(d.points).toEqual([]);
    expect(d.peak).toBeNull();
    expect(d.spikeCount).toBe(0);
    expect(d.spikeScore).toBe(SCORING_CONFIG.spikeScore);
    expect(d.featureOn).toBe(SCORING_CONFIG.featureOn);
  });

  it('sorts windows, clips the last one to the track and exposes each feature + both scores', () => {
    const d = shapeSignalLab({
      durationMs: 25_000,
      windows: [
        win(20_000, { pause: 0.5, rawScore: 0.3, emaScore: 0.2 }),
        win(0, { phase: 'baseline' }),
        win(10_000, { slowdown: 0.7, erase: 0.4, pressure: 0.1 }),
      ],
      events: [],
      baseline: [{ startMs: 0, endMs: 10_000 }],
    });
    expect(d.points.map((p) => [p.startMs, p.endMs, p.midMs])).toEqual([
      [0, 10_000, 5_000],
      [10_000, 20_000, 15_000],
      [20_000, 25_000, 22_500],
    ]);
    expect(d.points[2]).toMatchObject({ pause: 0.5, rawScore: 0.3, score: 0.2 });
    expect(d.points[1].featuresOn).toEqual(['slowdown', 'erase']);
    expect(d.pressureUsed).toBe(true);
    expect(d.baseline).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it('treats windows stored before phases existed as scored', () => {
    const w = win(0);
    delete w.phase;
    expect(shapeSignalLab({ durationMs: 10_000, windows: [w], events: [], baseline: [] }).points[0].phase).toBe('scored');
  });

  it('links each spike to the moment built from its window, else to the nearest moment within 15 s', () => {
    const d = shapeSignalLab({
      durationMs: 400_000,
      windows: [
        win(100_000, { isSpike: true, emaScore: 0.7 }),
        win(200_000, { isSpike: true, emaScore: 0.6 }),
        win(300_000, { isSpike: true, emaScore: 0.58 }),
      ],
      events: [
        event('gap', 100_000, { windowStartMs: 100_000 }),
        event('fix', 212_000, { type: 'misconception_corrected', status: 'resolved' }),
      ],
      baseline: [],
    });
    expect(d.points.map((p) => p.eventId)).toEqual(['gap', 'fix', null]);
    expect(d.points[1].eventType).toBe('misconception_corrected');
    expect(d.spikeCount).toBe(3);
    expect(d.peak?.startMs).toBe(100_000);
    expect(d.markers.map((m) => [m.id, m.lectureMs])).toEqual([
      ['gap', 100_000],
      ['fix', 212_000],
    ]);
  });

  it('explains a window above the line that was not flagged', () => {
    const d = shapeSignalLab({
      durationMs: 400_000,
      windows: [
        win(0, { phase: 'baseline', emaScore: 0.7, pause: 1, erase: 1 }),
        win(100_000, { emaScore: 0.6, pause: 1 }),
        win(200_000, { isSpike: true, emaScore: 0.6, pause: 1, erase: 1 }),
        win(210_000, { emaScore: 0.65, pause: 1, erase: 1 }),
        win(300_000, { emaScore: 0.58, pause: 1, slowdown: 1 }),
        win(350_000, { emaScore: 0.3 }),
      ],
      events: [],
      baseline: [],
    });
    expect(d.points.map((p) => p.note)).toEqual([
      expect.stringMatching(/baseline/i),
      expect.stringMatching(/only 1 signal on/),
      null,
      expect.stringMatching(/within 30 s of the last spike/),
      expect.stringMatching(/top 5/),
      null,
    ]);
  });

  it('pressure is reported unused when every window has none', () => {
    const d = shapeSignalLab({ durationMs: 20_000, windows: [win(0), win(10_000)], events: [], baseline: [] });
    expect(d.pressureUsed).toBe(false);
  });

  it('shapes the real demo session: one spike at the product-vs-chain gap, linked to its moment', () => {
    const words = transcript as TranscriptWord[];
    const page = buildMayaSession1('demo-maya-1');
    const windows = scoreSession({ sessionId: 'demo-maya-1', ...page, words, durationMs: 360_000 });
    const revisions = pairRevisions({ sessionId: 'demo-maya-1', ...page });
    const events = buildTimeline({
      sessionId: 'demo-maya-1',
      windows,
      revisions,
      words,
      conceptFor: createConceptTagger('demo-chain-rule', words).conceptFor,
    });
    const d = shapeSignalLab({ durationMs: 360_000, windows, events, baseline: baselineZones(windows, 360_000) });
    const spikes = d.points.filter((p) => p.isSpike);
    expect(spikes.map((p) => p.startMs)).toEqual([250_000]);
    expect(spikes[0].eventType).toBe('unresolved_gap');
    expect(spikes[0].reasons.length).toBeGreaterThanOrEqual(2);
    expect(d.baselineMs).toBeGreaterThan(0);
    expect(d.markers).toHaveLength(3);
  });
});

describe('helpers', () => {
  it('reviewHref opens the moment when there is one', () => {
    expect(reviewHref('abc', 'abc:unresolved_gap:250000')).toBe('/review/abc?moment=abc%3Aunresolved_gap%3A250000');
    expect(reviewHref('a b', null)).toBe('/review/a%20b');
  });

  it('timeTicks picks a round step with at most `max` intervals', () => {
    expect(timeTicks(360_000)).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000]);
    expect(timeTicks(40_000)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    expect(timeTicks(3_600_000).length).toBeLessThanOrEqual(8);
    expect(timeTicks(0)).toEqual([0]);
  });

  it('formatScore keeps two decimals', () => {
    expect(formatScore(0.5)).toBe('0.50');
    expect(formatScore(1)).toBe('1.00');
  });

  it('describePoint reads the window aloud: time, score vs threshold, features, reasons', () => {
    const d = shapeSignalLab({
      durationMs: 20_000,
      windows: [win(10_000, { isSpike: true, emaScore: 0.62, pause: 1, erase: 1, reasons: ['erased 1× (usual 0.0)'] })],
      events: [],
      baseline: [],
    });
    const text = describePoint(d.points[0], d.spikeScore);
    expect(text).toMatch(/^00:10–00:20/);
    expect(text).toMatch(/score 0\.62, above the 0\.55 threshold/);
    expect(text).toMatch(/spike/i);
    expect(text).toMatch(/erased 1×/);
    expect(FEATURES.map((f) => f.key)).toEqual(['pause', 'slowdown', 'erase', 'pressure']);
  });
});
