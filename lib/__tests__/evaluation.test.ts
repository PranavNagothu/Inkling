import { describe, expect, it } from 'vitest';
import groundTruthJson from '../../public/demo/ground-truth.json';
import { DEMO_SESSIONS, DEMO_TIMES } from '../demoScenario';
import {
  EVAL_TOLERANCE_MS,
  SWEEP_THRESHOLDS,
  demoEvaluationCases,
  evaluateCases,
  matchDetections,
  metricsFrom,
  momentDetections,
  parseGroundTruth,
  spikeDetections,
} from '../evaluation';
import { SCORING_CONFIG } from '../scoring';
import type { ConfusionWindow, TimelineEvent } from '../types';

const L = (...ms: number[]) => ms.map((atMs) => ({ atMs }));
const D = (...ms: number[]) => ms.map((atMs) => ({ atMs }));

describe('matchDetections', () => {
  it('empty labels and detections: nothing matched, nothing missed', () => {
    const r = matchDetections([], []);
    expect(r.matches).toEqual([]);
    expect(r.falsePositives).toEqual([]);
    expect(r.falseNegatives).toEqual([]);
  });

  it('no detections: every label is a false negative', () => {
    const r = matchDetections(L(10_000, 50_000), []);
    expect(r.falseNegatives.map((f) => f.label.atMs)).toEqual([10_000, 50_000]);
    expect(r.matches).toHaveLength(0);
  });

  it('no labels: every detection is a false positive', () => {
    const r = matchDetections([], D(10_000, 50_000));
    expect(r.falsePositives.map((f) => f.detection.atMs)).toEqual([10_000, 50_000]);
  });

  it('matches within the tolerance (inclusive) and rejects outside it', () => {
    const r = matchDetections(L(100_000, 200_000), D(115_000, 215_001));
    expect(r.matches.map((m) => [m.label.atMs, m.detection.atMs, m.deltaMs])).toEqual([[100_000, 115_000, 15_000]]);
    expect(r.falseNegatives.map((f) => f.label.atMs)).toEqual([200_000]);
    expect(r.falsePositives.map((f) => f.detection.atMs)).toEqual([215_001]);
  });

  it('deltaMs is signed: detection minus label', () => {
    const r = matchDetections(L(100_000), D(92_000));
    expect(r.matches[0].deltaMs).toBe(-8_000);
  });

  it('is one-to-one: duplicate detections of one label count one TP and one FP', () => {
    const r = matchDetections(L(100_000), D(101_000, 101_000));
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].detectionIndex).toBe(0);
    expect(r.falsePositives.map((f) => f.detectionIndex)).toEqual([1]);
  });

  it('is one-to-one: duplicate labels matched by a single detection leave one FN', () => {
    const r = matchDetections(L(100_000, 100_000), D(104_000));
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].labelIndex).toBe(0);
    expect(r.falseNegatives.map((f) => f.labelIndex)).toEqual([1]);
  });

  it('greedy by nearest: the closest pair wins even when an earlier label could take it', () => {
    // Detection 112 s is 12 s from label 100 s but only 2 s from label 110 s → it goes to 110 s.
    const r = matchDetections(L(100_000, 110_000), D(112_000));
    expect(r.matches.map((m) => m.label.atMs)).toEqual([110_000]);
    expect(r.falseNegatives.map((f) => f.label.atMs)).toEqual([100_000]);
  });

  it('greedy nearest-first also frees a second detection for the other label', () => {
    const r = matchDetections(L(100_000, 110_000), D(104_000, 108_000));
    // Reported in label-time order.
    expect(r.matches.map((m) => [m.label.atMs, m.detection.atMs])).toEqual([
      [100_000, 104_000],
      [110_000, 108_000],
    ]);
    expect(r.falsePositives).toHaveLength(0);
    expect(r.falseNegatives).toHaveLength(0);
  });

  it('ties are broken deterministically: earlier label, then earlier detection', () => {
    // Detection 105 s is exactly 5 s from both labels → the earlier label takes it.
    const r = matchDetections(L(110_000, 100_000), D(105_000));
    expect(r.matches[0].label.atMs).toBe(100_000);
    // Two detections equidistant from one label → the earlier detection is the match.
    const r2 = matchDetections(L(100_000), D(106_000, 94_000));
    expect(r2.matches[0].detection.atMs).toBe(94_000);
    expect(r2.falsePositives[0].detection.atMs).toBe(106_000);
  });

  it('respects a custom tolerance and never mutates its inputs', () => {
    const labels = L(100_000);
    const dets = D(104_000);
    const snapshot = JSON.stringify([labels, dets]);
    expect(matchDetections(labels, dets, 3_000).matches).toHaveLength(0);
    expect(JSON.stringify([labels, dets])).toBe(snapshot);
  });
});

describe('metricsFrom', () => {
  it('computes precision, recall and F1', () => {
    const m = metricsFrom({ tp: 1, fp: 1, fn: 2 });
    expect(m.precision).toBeCloseTo(0.5);
    expect(m.recall).toBeCloseTo(1 / 3);
    expect(m.f1).toBeCloseTo(0.4);
  });

  it('precision is undefined (null) with no detections; recall is undefined with no labels', () => {
    expect(metricsFrom({ tp: 0, fp: 0, fn: 3 })).toMatchObject({ precision: null, recall: 0, f1: null });
    expect(metricsFrom({ tp: 0, fp: 2, fn: 0 })).toMatchObject({ precision: 0, recall: null, f1: null });
    expect(metricsFrom({ tp: 0, fp: 0, fn: 0 })).toMatchObject({ precision: null, recall: null, f1: null });
  });

  it('F1 is 0 (not NaN) when precision and recall are both 0', () => {
    expect(metricsFrom({ tp: 0, fp: 1, fn: 1 }).f1).toBe(0);
  });
});

function win(bucketStartMs: number, isSpike: boolean, emaScore = 0.6): ConfusionWindow {
  return { sessionId: 's', bucketStartMs, pause: 0, slowdown: 0, erase: 0, pressure: null, rawScore: emaScore, emaScore, isSpike, reasons: [] };
}

describe('detections', () => {
  it('a spike is detected at the centre of its scoring window', () => {
    const d = spikeDetections([win(0, false), win(250_000, true, 0.59), win(260_000, false)]);
    expect(d).toEqual([{ atMs: 250_000 + SCORING_CONFIG.windowMs / 2, ref: 'window@250000', score: 0.59 }]);
  });

  it('a moment is detected at its lecture time', () => {
    const e = { id: 'x', lectureMs: 62_000 } as TimelineEvent;
    expect(momentDetections([e])).toEqual([{ atMs: 62_000, ref: 'x' }]);
  });
});

describe('ground truth', () => {
  const gt = parseGroundTruth(groundTruthJson);

  it('parses and is derived from the scenario’s own intended moments', () => {
    expect(gt.toleranceMs).toBe(EVAL_TOLERANCE_MS);
    expect(gt.note).toMatch(/demoScenario/);
    const s1 = gt.sessions.find((s) => s.sessionId === DEMO_SESSIONS.s1.id)!;
    const s2 = gt.sessions.find((s) => s.sessionId === DEMO_SESSIONS.s2.id)!;
    expect(s1.labels.map((l) => l.atMs).slice(0, 2)).toEqual([DEMO_TIMES.breakthroughEraseMs, DEMO_TIMES.correctionEraseMs]);
    expect(s1.labels[2].atMs).toBeGreaterThanOrEqual(DEMO_TIMES.gapFromMs);
    expect(s1.labels[2].atMs).toBeLessThan(DEMO_TIMES.gapToMs);
    expect(s2.labels).toEqual([]);
  });

  it('rejects malformed files', () => {
    expect(() => parseGroundTruth(null)).toThrow();
    expect(() => parseGroundTruth({ sessions: [{ sessionId: 'a', labels: [{ atMs: 'x' }] }] })).toThrow();
    expect(() => parseGroundTruth({ toleranceMs: -1, sessions: [] })).toThrow();
  });
});

describe('evaluating the demo set', () => {
  const gt = parseGroundTruth(groundTruthJson);
  const cases = demoEvaluationCases(gt);
  const report = evaluateCases(cases, { toleranceMs: gt.toleranceMs });

  it('builds one case per labeled session, from the same builders the seed stores', () => {
    expect(cases.map((c) => c.sessionId)).toEqual([DEMO_SESSIONS.s1.id, DEMO_SESSIONS.s2.id]);
    expect(cases.every((c) => c.strokes.length > 0 && c.source === 'scenario')).toBe(true);
    expect(report.labelCount).toBe(3);
  });

  it('hesitation spikes: one TP at the product-vs-chain gap; the two corrections fall in the baseline', () => {
    expect(report.spikes).toMatchObject({ tp: 1, fp: 0, fn: 2 });
    expect(report.spikes.precision).toBe(1);
    expect(report.spikes.recall).toBeCloseTo(1 / 3);
    const s1 = report.cases[0];
    expect(s1.spikes.matches.map((m) => m.label.atMs)).toEqual([246_500]);
    expect(s1.spikes.falseNegatives.map((f) => f.label.atMs)).toEqual([62_000, 100_000]);
    // …both inside the stretch that calibrates "her normal", where spikes are never flagged by design.
    for (const { label } of s1.spikes.falseNegatives) {
      expect(s1.baseline.some((z) => label.atMs >= z.startMs && label.atMs < z.endMs)).toBe(true);
    }
  });

  it('the full pipeline (moments: spikes + paired corrections) finds all three labels', () => {
    expect(report.moments).toMatchObject({ tp: 3, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
  });

  it('sweeps spikeScore 0.35..0.8 and recomputes spikes at each threshold', () => {
    expect(SWEEP_THRESHOLDS[0]).toBe(0.35);
    expect(SWEEP_THRESHOLDS[SWEEP_THRESHOLDS.length - 1]).toBe(0.8);
    expect(report.sweep.map((p) => p.spikeScore)).toEqual(SWEEP_THRESHOLDS);
    const at = (t: number) => report.sweep.find((p) => p.spikeScore === t)!;
    expect(at(SCORING_CONFIG.spikeScore)).toMatchObject({ tp: 1, fp: 0, fn: 2 });
    // Raising the bar past the peak window's score flags nothing: precision undefined, recall 0.
    expect(at(0.8)).toMatchObject({ tp: 0, fp: 0, precision: null, recall: 0 });
    for (const p of report.sweep) expect(p.recall === null || (p.recall >= 0 && p.recall <= 1)).toBe(true);
  });

  it('the default report uses the shipped spike threshold', () => {
    expect(report.spikeScore).toBe(SCORING_CONFIG.spikeScore);
  });
});
