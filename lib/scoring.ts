// Hesitation scoring engine. Pure function: raw ink/erase/transcript signals in, ConfusionWindow[] out.
import type { ConfusionWindow, EraseEvent, Stroke, TimeRange, TranscriptWord, WindowPhase } from './types';
import { activeStrokes } from './ink';

export interface ScoringWeights {
  pause: number;
  slowdown: number;
  erase: number;
  pressure: number;
}

export interface ScoringConfigShape {
  windowMs: number;
  baselineMs: number;
  activityGapMs: number;
  pauseGapMs: number;
  minWordsForPause: number;
  minStrokesForSlowdown: number;
  pressureVarianceMin: number;
  weights: ScoringWeights;
  emaAlpha: number;
  spikeScore: number;
  featureOn: number;
  minFeaturesOn: number;
  refractoryMs: number;
  maxSpikes: number;
}

export const SCORING_CONFIG = {
  windowMs: 10000,
  /** How much of the student's own writing calibrates "your normal" (the baseline). */
  baselineMs: 120000,
  /**
   * A window with no ink or erasing within this distance (either side) is a stretch the student
   * skipped or was away for: idle, not a hesitation. Shorter silences next to writing are scored.
   */
  activityGapMs: 60000,
  pauseGapMs: 6000,
  minWordsForPause: 8,
  minStrokesForSlowdown: 2,
  pressureVarianceMin: 0.01,
  weights: { pause: 0.3, slowdown: 0.3, erase: 0.25, pressure: 0.15 },
  emaAlpha: 0.5,
  spikeScore: 0.55,
  featureOn: 0.4,
  minFeaturesOn: 2,
  refractoryMs: 30000,
  maxSpikes: 5,
} as const;

const EPS = 1e-6;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Median of a list of numbers. Returns 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation. Returns 0 for an empty list. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

/**
 * Robust (median/MAD based) z-score. Guards against a MAD of 0 with a tiny
 * epsilon in the denominator so the result is always finite (never NaN/Infinity).
 */
export function robustZ(x: number, med: number, madValue: number): number {
  const denom = 1.4826 * madValue + EPS;
  return (x - med) / denom;
}

/** Percentile (0..100) with linear interpolation between ranks. Returns 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
}

/** Merge (possibly overlapping/touching) stroke intervals into disjoint, sorted intervals. */
function mergeIntervals(strokes: Stroke[]): Array<[number, number]> {
  const intervals = strokes.map((s) => [s.startMs, s.endMs] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Gaps (no-ink stretches) between merged ink intervals, including before the first and after the last. */
function computeGaps(merged: Array<[number, number]>, durationMs: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < durationMs) gaps.push([cursor, durationMs]);
  return gaps;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * True when an erase was later reversed: every stroke it erased is known and live again (an undone
 * scribble-out or strike-through, or toolbar Undo right after an eraser gesture — lib/eraseUndo).
 * Such an event is kept in storage (nothing is hard-deleted) but no longer counts as erasing.
 */
export function isReversedErase(event: EraseEvent, strokes: Stroke[]): boolean {
  if (event.strokeIds.length === 0) return false;
  const byId = new Map(strokes.map((s) => [s.id, s]));
  return event.strokeIds.every((id) => {
    const s = byId.get(id);
    return !!s && !s.erased;
  });
}

interface WindowCalc {
  phase: WindowPhase;
  bucketStartMs: number;
  windowStart: number;
  windowEnd: number;
  idleMs: number;
  wordsInWindow: number;
  pauseRaw: number;
  speedRaw: number | null;
  eraseCountRaw: number;
  pressureRaw: number | null;
}

/** True when ink [start, end] or an instant touches the window [ws, we), widened by `padMs` each side. */
function near(start: number, end: number, ws: number, we: number, padMs: number): boolean {
  return start < we + padMs && end >= ws - padMs;
}

/**
 * Sets each window's phase from the student's own activity (see WindowPhase):
 * - windows before the bucket holding their first stroke are idle;
 * - the baseline is the first `baselineMs / windowMs` windows that hold ink (so it follows a
 *   student who starts mid-lecture or jumps ahead);
 * - after that, a window is scored when there is ink or erasing within `activityGapMs` of it, else idle.
 * Without any ink the baseline falls back to the start of the lecture and nothing is idle.
 */
function assignPhases(
  calcs: WindowCalc[],
  { ink, erases, config }: { ink: Stroke[]; erases: EraseEvent[]; config: ScoringConfigShape },
): void {
  const baselineCount = Math.max(1, Math.floor(config.baselineMs / config.windowMs));
  if (ink.length === 0) {
    for (const c of calcs) c.phase = c.windowEnd <= config.baselineMs ? 'baseline' : 'scored';
    return;
  }
  const firstInkMs = Math.min(...ink.map((s) => s.startMs));
  const activity: Array<[number, number]> = [
    ...ink.map((s) => [s.startMs, s.endMs] as [number, number]),
    ...erases.filter((e) => e.atMs >= firstInkMs).map((e) => [e.atMs, e.atMs] as [number, number]),
  ];
  let baselineLeft = baselineCount;
  for (const c of calcs) {
    if (c.windowEnd <= firstInkMs) {
      c.phase = 'idle';
    } else if (baselineLeft > 0 && ink.some((s) => near(s.startMs, s.endMs, c.windowStart, c.windowEnd, 0))) {
      c.phase = 'baseline';
      baselineLeft--;
    } else if (activity.some(([s, e]) => near(s, e, c.windowStart, c.windowEnd, config.activityGapMs))) {
      c.phase = 'scored';
    } else {
      c.phase = 'idle';
    }
  }
}

/**
 * The stretch of lecture time the baseline was computed from: first baseline window to the end of
 * the last. Null for windows scored before phases existed (or with no baseline window).
 */
export function baselineRange(windows: ConfusionWindow[], windowMs: number = SCORING_CONFIG.windowMs): TimeRange | null {
  const starts = windows.filter((w) => w.phase === 'baseline').map((w) => w.bucketStartMs);
  if (starts.length === 0) return null;
  return { startMs: Math.min(...starts), endMs: Math.max(...starts) + windowMs };
}

/**
 * The baseline as contiguous stretches (a student who jumps around calibrates on separate stretches),
 * clipped to the track. Analyses stored before phases existed used the first `baselineMs` of the lecture.
 */
export function baselineZones(
  windows: ConfusionWindow[],
  durationMs: number,
  windowMs: number = SCORING_CONFIG.windowMs,
): TimeRange[] {
  if (windows.length === 0 || durationMs <= 0) return [];
  if (!windows.some((w) => w.phase)) return [{ startMs: 0, endMs: Math.min(SCORING_CONFIG.baselineMs, durationMs) }];
  const zones: TimeRange[] = [];
  for (const w of [...windows].sort((a, b) => a.bucketStartMs - b.bucketStartMs)) {
    if (w.phase !== 'baseline') continue;
    const endMs = Math.min(w.bucketStartMs + windowMs, durationMs);
    const last = zones[zones.length - 1];
    if (last && last.endMs >= w.bucketStartMs) last.endMs = Math.max(last.endMs, endMs);
    else zones.push({ startMs: w.bucketStartMs, endMs });
  }
  return zones;
}

export function scoreSession(input: {
  sessionId: string;
  strokes: Stroke[];
  eraseEvents: EraseEvent[];
  words: TranscriptWord[];
  durationMs: number;
  /**
   * False when the lecture has no transcript at all. The pause feature needs the transcript to know
   * the lecturer was talking during a silence, so without one it is disabled (always 0) and its
   * weight is shared out among the other features — a hesitation then needs slowdown + erasing.
   * Defaults to true (an empty word list just means nobody spoke).
   */
  hasTranscript?: boolean;
  config?: Partial<ScoringConfigShape>;
}): ConfusionWindow[] {
  const config: ScoringConfigShape = {
    ...SCORING_CONFIG,
    ...input.config,
    weights: { ...SCORING_CONFIG.weights, ...(input.config?.weights ?? {}) },
  };
  const { sessionId, eraseEvents, words, durationMs } = input;
  const pauseEnabled = input.hasTranscript !== false;
  // Strokes cut by a partial erase are represented by their pieces (never counted twice).
  const strokes = activeStrokes(input.strokes);
  const windowMs = config.windowMs;
  const numWindows = Math.max(0, Math.ceil(durationMs / windowMs));

  const merged = mergeIntervals(strokes);
  const gaps = computeGaps(merged, durationMs);
  const qualifyingGaps = gaps.filter(([s, e]) => e - s >= config.pauseGapMs);

  const realErases = eraseEvents.filter((e) => e.by !== 'undo' && !isReversedErase(e, input.strokes));
  const penStrokesExist = strokes.some((s) => s.pointerType === 'pen');

  const calcs: WindowCalc[] = [];
  for (let i = 0; i < numWindows; i++) {
    const windowStart = i * windowMs;
    const windowEnd = Math.min((i + 1) * windowMs, durationMs);
    const windowLen = windowEnd - windowStart;

    let idleMs = 0;
    for (const [gs, ge] of qualifyingGaps) idleMs += overlapMs(gs, ge, windowStart, windowEnd);
    const idleFrac = windowLen > 0 ? idleMs / windowLen : 0;

    const wordsInWindow = words.filter((w) => w.startMs >= windowStart && w.startMs < windowEnd).length;
    const pauseRaw = pauseEnabled && wordsInWindow >= config.minWordsForPause ? idleFrac : 0;

    const strokesStarting = strokes.filter((s) => s.startMs >= windowStart && s.startMs < windowEnd);
    const speedRaw =
      strokesStarting.length >= config.minStrokesForSlowdown
        ? median(strokesStarting.map((s) => s.medianSpeed))
        : null;

    const eraseCountRaw = realErases.filter((e) => e.atMs >= windowStart && e.atMs < windowEnd).length;

    let pressureRaw: number | null = null;
    if (penStrokesExist) {
      const pressures: number[] = [];
      for (const s of strokes) {
        if (s.pointerType !== 'pen') continue;
        for (const p of s.points) {
          if (p[3] >= windowStart && p[3] < windowEnd) pressures.push(p[2]);
        }
      }
      if (pressures.length > 0) pressureRaw = percentile(pressures, 90);
    }

    calcs.push({
      phase: 'scored', // assigned below
      bucketStartMs: windowStart,
      windowStart,
      windowEnd,
      idleMs,
      wordsInWindow,
      pauseRaw,
      speedRaw,
      eraseCountRaw,
      pressureRaw,
    });
  }

  assignPhases(calcs, {
    // Undone strokes were taken back at once: they don't show where the student started writing.
    ink: strokes.filter((s) => s.erasedBy !== 'undo'),
    erases: realErases,
    config,
  });
  const baselineCalcs = calcs.filter((c) => c.phase === 'baseline');

  const baselinePauseArr = baselineCalcs.map((c) => c.pauseRaw);
  const baselineEraseArr = baselineCalcs.map((c) => c.eraseCountRaw);
  const baselinePressureArr = baselineCalcs.map((c) => c.pressureRaw).filter((v): v is number => v !== null);
  const baselineSpeedArr = baselineCalcs.map((c) => c.speedRaw).filter((v): v is number => v !== null);

  const medianPause = median(baselinePauseArr);
  const madPause = mad(baselinePauseArr);
  const medianErase = median(baselineEraseArr);
  const madErase = mad(baselineEraseArr);
  const medianPressure = median(baselinePressureArr);
  const madPressure = mad(baselinePressureArr);
  const baselineMedianSpeed = baselineSpeedArr.length > 0 ? median(baselineSpeedArr) : null;

  const pressureVariance = variance(baselinePressureArr);
  const pressureUsable =
    penStrokesExist && baselinePressureArr.length > 0 && pressureVariance > config.pressureVarianceMin;

  const rawWeights = config.weights;
  let adjustedWeights: ScoringWeights;
  if (!pauseEnabled) {
    // No transcript: the pause weight is shared out among the remaining (usable) features.
    const pressureW = pressureUsable ? rawWeights.pressure : 0;
    const sum = rawWeights.slowdown + rawWeights.erase + pressureW;
    adjustedWeights =
      sum > 0
        ? { pause: 0, slowdown: rawWeights.slowdown / sum, erase: rawWeights.erase / sum, pressure: pressureW / sum }
        : { pause: 0, slowdown: 0, erase: 0, pressure: 0 };
  } else if (pressureUsable) {
    adjustedWeights = { ...rawWeights };
  } else {
    const sumOthers = rawWeights.pause + rawWeights.slowdown + rawWeights.erase;
    adjustedWeights =
      sumOthers > 0
        ? {
            pause: rawWeights.pause / sumOthers,
            slowdown: rawWeights.slowdown / sumOthers,
            erase: rawWeights.erase / sumOthers,
            pressure: 0,
          }
        : { pause: 0, slowdown: 0, erase: 0, pressure: 0 };
  }

  const windows: ConfusionWindow[] = [];
  let prevEma = 0;

  for (const c of calcs) {
    if (c.phase === 'idle') {
      // Nothing to compare: the student was not taking notes here. The smoothing restarts too.
      prevEma = 0;
      windows.push({
        sessionId,
        bucketStartMs: c.bucketStartMs,
        pause: 0,
        slowdown: 0,
        erase: 0,
        pressure: null,
        rawScore: 0,
        emaScore: 0,
        isSpike: false,
        reasons: [],
        phase: 'idle',
      });
      continue;
    }
    const pauseFeature = clamp(robustZ(c.pauseRaw, medianPause, madPause) / 3, 0, 1);
    const eraseFeature = clamp(robustZ(c.eraseCountRaw, medianErase, madErase) / 3, 0, 1);

    let slowdownFeature = 0;
    if (c.speedRaw !== null && baselineMedianSpeed !== null && baselineMedianSpeed > 0) {
      slowdownFeature = clamp(1 - c.speedRaw / baselineMedianSpeed, 0, 1);
    }

    let pressureFeature: number | null = null;
    if (pressureUsable && c.pressureRaw !== null) {
      pressureFeature = clamp(robustZ(c.pressureRaw, medianPressure, madPressure) / 3, 0, 1);
    }

    const rawScore =
      adjustedWeights.pause * pauseFeature +
      adjustedWeights.slowdown * slowdownFeature +
      adjustedWeights.erase * eraseFeature +
      (pressureFeature !== null ? adjustedWeights.pressure * pressureFeature : 0);

    const emaScore = config.emaAlpha * rawScore + (1 - config.emaAlpha) * prevEma;
    prevEma = emaScore;

    const reasons: string[] = [];
    if (pauseFeature >= config.featureOn) {
      reasons.push(`paused ${Math.round(c.idleMs / 1000)}s while ${c.wordsInWindow} words were spoken`);
    }
    if (slowdownFeature >= config.featureOn) {
      reasons.push(`writing ${Math.round(slowdownFeature * 100)}% slower than usual`);
    }
    if (eraseFeature >= config.featureOn) {
      const usual = (Math.round(medianErase * 10) / 10).toFixed(1);
      reasons.push(`erased ${c.eraseCountRaw}× (usual ${usual})`);
    }
    if (pressureFeature !== null && pressureFeature >= config.featureOn) {
      reasons.push('pressing harder than usual');
    }

    windows.push({
      sessionId,
      bucketStartMs: c.bucketStartMs,
      pause: pauseFeature,
      slowdown: slowdownFeature,
      erase: eraseFeature,
      pressure: pressureFeature,
      rawScore,
      emaScore,
      isSpike: false,
      reasons,
      phase: c.phase,
    });
  }

  // Spike detection: sequential greedy acceptance respecting the refractory period,
  // then cap to the top `maxSpikes` by emaScore.
  let lastSpikeStart: number | null = null;
  const candidates: { index: number; emaScore: number }[] = [];
  for (let i = 0; i < calcs.length; i++) {
    if (calcs[i].phase !== 'scored') continue; // idle and baseline windows never spike
    const w = windows[i];
    let featuresOn = 0;
    if (w.pause >= config.featureOn) featuresOn++;
    if (w.slowdown >= config.featureOn) featuresOn++;
    if (w.erase >= config.featureOn) featuresOn++;
    if (w.pressure !== null && w.pressure >= config.featureOn) featuresOn++;

    const meetsThreshold = w.emaScore >= config.spikeScore && featuresOn >= config.minFeaturesOn;
    const inRefractory = lastSpikeStart !== null && w.bucketStartMs - lastSpikeStart < config.refractoryMs;

    if (meetsThreshold && !inRefractory) {
      candidates.push({ index: i, emaScore: w.emaScore });
      lastSpikeStart = w.bucketStartMs;
    }
  }

  candidates.sort((a, b) => b.emaScore - a.emaScore);
  for (const cand of candidates.slice(0, config.maxSpikes)) {
    windows[cand.index].isSpike = true;
  }

  return windows;
}
