// Model evaluation: how well Inkling's detectors agree with hand labels of where a student was
// confused (lecture times she would have marked "?"). Pure — safe on client and server.
//
// - Matching is one-to-one within ±toleranceMs, greedy by nearest pair (ties: earlier label, then
//   earlier detection), so a duplicate detection is a false positive, never a second true positive.
// - Two detectors are scored: hesitation spikes alone (lib/scoring; a spike's time is the centre of
//   its 10 s window) and the full pipeline's moments (spikes + paired corrections, lib/classify).
// - The sensitivity sweep re-runs scoreSession at each spikeScore on the same ink and transcript.
//
// The labeled set (public/demo/ground-truth.json) is a small demo set, not a benchmark.
import transcript from "@/public/demo/lecture.transcript.json";
import lecture from "@/public/demo/lecture.json";
import { buildTimeline } from "./classify";
import { createConceptTagger } from "./concepts";
import { buildMayaSession1, buildMayaSession2, type ScenarioPage } from "./demoScenario";
import { pairRevisions } from "./pairing";
import { SCORING_CONFIG, baselineZones, scoreSession } from "./scoring";
import type { ConfusionWindow, EraseEvent, Stroke, TimeRange, TimelineEvent, TranscriptWord } from "./types";

export const EVAL_TOLERANCE_MS = 15_000;

/** spikeScore values swept by the sensitivity analysis: 0.35, 0.40, … 0.80. */
export const SWEEP_THRESHOLDS: number[] = Array.from({ length: 10 }, (_, i) => Math.round((0.35 + i * 0.05) * 100) / 100);

export interface GroundTruthLabel {
  atMs: number;
  text?: string;
  source?: string;
}

export interface Detection {
  atMs: number;
  /** What produced it (window@<bucketStartMs> or an event id). */
  ref?: string;
  score?: number;
}

export interface Match {
  label: GroundTruthLabel;
  labelIndex: number;
  detection: Detection;
  detectionIndex: number;
  /** Detection time minus label time (negative = flagged before the label). */
  deltaMs: number;
}

export interface MatchResult {
  /** True positives, in label-time order. */
  matches: Match[];
  falsePositives: Array<{ detection: Detection; detectionIndex: number }>;
  falseNegatives: Array<{ label: GroundTruthLabel; labelIndex: number }>;
}

export interface Metrics {
  tp: number;
  fp: number;
  fn: number;
  /** null when nothing was detected (undefined, not 0). */
  precision: number | null;
  /** null when there is nothing to find. */
  recall: number | null;
  /** null when precision or recall is undefined. */
  f1: number | null;
}

export function matchDetections(
  labels: GroundTruthLabel[],
  detections: Detection[],
  toleranceMs: number = EVAL_TOLERANCE_MS,
): MatchResult {
  const pairs: Array<{ li: number; di: number; dist: number }> = [];
  labels.forEach((l, li) =>
    detections.forEach((d, di) => {
      const dist = Math.abs(d.atMs - l.atMs);
      if (dist <= toleranceMs) pairs.push({ li, di, dist });
    }),
  );
  pairs.sort(
    (a, b) =>
      a.dist - b.dist ||
      labels[a.li].atMs - labels[b.li].atMs ||
      a.li - b.li ||
      detections[a.di].atMs - detections[b.di].atMs ||
      a.di - b.di,
  );
  const usedLabels = new Set<number>();
  const usedDetections = new Set<number>();
  const matches: Match[] = [];
  for (const { li, di } of pairs) {
    if (usedLabels.has(li) || usedDetections.has(di)) continue;
    usedLabels.add(li);
    usedDetections.add(di);
    matches.push({ label: labels[li], labelIndex: li, detection: detections[di], detectionIndex: di, deltaMs: detections[di].atMs - labels[li].atMs });
  }
  matches.sort((a, b) => a.label.atMs - b.label.atMs || a.labelIndex - b.labelIndex);
  return {
    matches,
    falsePositives: detections.flatMap((detection, detectionIndex) => (usedDetections.has(detectionIndex) ? [] : [{ detection, detectionIndex }])),
    falseNegatives: labels.flatMap((label, labelIndex) => (usedLabels.has(labelIndex) ? [] : [{ label, labelIndex }])),
  };
}

export function metricsFrom({ tp, fp, fn }: { tp: number; fp: number; fn: number }): Metrics {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

/** Micro-averaged metrics over several sessions' match results. */
export function sumMetrics(results: MatchResult[]): Metrics {
  return metricsFrom({
    tp: results.reduce((n, r) => n + r.matches.length, 0),
    fp: results.reduce((n, r) => n + r.falsePositives.length, 0),
    fn: results.reduce((n, r) => n + r.falseNegatives.length, 0),
  });
}

/** Hesitation spikes as detections, at the centre of their scoring window. */
export function spikeDetections(windows: ConfusionWindow[], windowMs: number = SCORING_CONFIG.windowMs): Detection[] {
  return windows
    .filter((w) => w.isSpike)
    .map((w) => ({ atMs: w.bucketStartMs + windowMs / 2, ref: `window@${w.bucketStartMs}`, score: w.emaScore }));
}

/** Timeline moments as detections, at their lecture time. */
export function momentDetections(events: Pick<TimelineEvent, "id" | "lectureMs">[]): Detection[] {
  return events.map((e) => ({ atMs: e.lectureMs, ref: e.id }));
}

// ---------------------------------------------------------------------------------------------
// Ground truth file

export interface GroundTruthSession {
  sessionId: string;
  title: string;
  scenario?: string;
  labels: GroundTruthLabel[];
}

export interface GroundTruth {
  name: string;
  lectureId: string;
  toleranceMs: number;
  note: string;
  sessions: GroundTruthSession[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validates a ground-truth file (public/demo/ground-truth.json). Throws on anything malformed. */
export function parseGroundTruth(raw: unknown): GroundTruth {
  if (!isObj(raw)) throw new Error("ground truth: expected an object");
  const toleranceMs = raw.toleranceMs ?? EVAL_TOLERANCE_MS;
  if (!finiteNonNeg(toleranceMs)) throw new Error("ground truth: toleranceMs must be a non-negative number");
  if (!Array.isArray(raw.sessions)) throw new Error("ground truth: sessions must be an array");
  const sessions = raw.sessions.map((s, i): GroundTruthSession => {
    if (!isObj(s) || typeof s.sessionId !== "string" || !Array.isArray(s.labels)) {
      throw new Error(`ground truth: session ${i} needs a sessionId and a labels array`);
    }
    const labels = s.labels.map((l, j): GroundTruthLabel => {
      if (!isObj(l) || !finiteNonNeg(l.atMs)) throw new Error(`ground truth: session ${i} label ${j} needs atMs >= 0`);
      return {
        atMs: l.atMs,
        ...(typeof l.text === "string" ? { text: l.text } : {}),
        ...(typeof l.source === "string" ? { source: l.source } : {}),
      };
    });
    return {
      sessionId: s.sessionId,
      title: typeof s.title === "string" ? s.title : s.sessionId,
      ...(typeof s.scenario === "string" ? { scenario: s.scenario } : {}),
      labels: [...labels].sort((a, b) => a.atMs - b.atMs),
    };
  });
  return {
    name: typeof raw.name === "string" ? raw.name : "Ground truth",
    lectureId: typeof raw.lectureId === "string" ? raw.lectureId : lecture.lectureId,
    toleranceMs,
    note: typeof raw.note === "string" ? raw.note : "",
    sessions,
  };
}

// ---------------------------------------------------------------------------------------------
// Evaluating sessions

export interface EvalCase {
  sessionId: string;
  title: string;
  lectureId: string;
  strokes: Stroke[];
  eraseEvents: EraseEvent[];
  words: TranscriptWord[];
  durationMs: number;
  hasTranscript: boolean;
  labels: GroundTruthLabel[];
  /** 'stored' = the session's ink read from the database; 'scenario' = rebuilt by lib/demoScenario. */
  source: "stored" | "scenario";
}

export interface CaseResult {
  sessionId: string;
  title: string;
  source: EvalCase["source"];
  labels: GroundTruthLabel[];
  spikes: MatchResult;
  moments: MatchResult;
  /** The moments' types by event id (for the per-label table). */
  momentTypes: Record<string, TimelineEvent["type"]>;
  /** Where the baseline was measured: spikes are never flagged there by design. */
  baseline: TimeRange[];
}

export interface SweepPoint extends Metrics {
  spikeScore: number;
}

export interface EvaluationReport {
  toleranceMs: number;
  spikeScore: number;
  windowMs: number;
  sessionCount: number;
  labelCount: number;
  cases: CaseResult[];
  spikes: Metrics;
  moments: Metrics;
  sweep: SweepPoint[];
}

function scoreCase(c: EvalCase, spikeScore: number): ConfusionWindow[] {
  return scoreSession({
    sessionId: c.sessionId,
    strokes: c.strokes,
    eraseEvents: c.eraseEvents,
    words: c.words,
    durationMs: c.durationMs,
    hasTranscript: c.hasTranscript,
    config: { spikeScore },
  });
}

/** Scores every case with the app's own pipeline and matches its output against the labels. */
export function evaluateCases(
  cases: EvalCase[],
  opts: { toleranceMs?: number; spikeScore?: number; thresholds?: number[] } = {},
): EvaluationReport {
  const toleranceMs = opts.toleranceMs ?? EVAL_TOLERANCE_MS;
  const spikeScore = opts.spikeScore ?? SCORING_CONFIG.spikeScore;
  const results: CaseResult[] = cases.map((c) => {
    const windows = scoreCase(c, spikeScore);
    const revisions = pairRevisions({ sessionId: c.sessionId, strokes: c.strokes, eraseEvents: c.eraseEvents });
    const tagger = createConceptTagger(c.lectureId, c.words);
    const events = buildTimeline({ sessionId: c.sessionId, windows, revisions, words: c.words, conceptFor: tagger.conceptFor });
    return {
      sessionId: c.sessionId,
      title: c.title,
      source: c.source,
      labels: c.labels,
      spikes: matchDetections(c.labels, spikeDetections(windows), toleranceMs),
      moments: matchDetections(c.labels, momentDetections(events), toleranceMs),
      momentTypes: Object.fromEntries(events.map((e) => [e.id, e.type])),
      baseline: baselineZones(windows, c.durationMs),
    };
  });
  const sweep = (opts.thresholds ?? SWEEP_THRESHOLDS).map((t) => ({
    spikeScore: t,
    ...sumMetrics(cases.map((c) => matchDetections(c.labels, spikeDetections(scoreCase(c, t)), toleranceMs))),
  }));
  return {
    toleranceMs,
    spikeScore,
    windowMs: SCORING_CONFIG.windowMs,
    sessionCount: cases.length,
    labelCount: cases.reduce((n, c) => n + c.labels.length, 0),
    cases: results,
    spikes: sumMetrics(results.map((r) => r.spikes)),
    moments: sumMetrics(results.map((r) => r.moments)),
    sweep,
  };
}

const SCENARIO_BUILDERS: Record<string, (sessionId: string) => ScenarioPage> = {
  buildMayaSession1,
  buildMayaSession2,
};

/** The track length the app analyses: the lecture, extended if ink runs past its end (lib/analyze). */
function trackMs(lectureMs: number, page: ScenarioPage): number {
  let last = lectureMs;
  for (const s of page.strokes) last = Math.max(last, s.endMs, s.erasedAtMs ?? 0);
  for (const e of page.eraseEvents) last = Math.max(last, e.atMs);
  return Math.ceil(last);
}

/**
 * The labeled demo set rebuilt from the scenario builders (the exact ink `npm run seed:demo`
 * stores) and the bundled transcript — no database needed.
 */
export function demoEvaluationCases(gt: GroundTruth): EvalCase[] {
  const words = transcript as TranscriptWord[];
  return gt.sessions.flatMap((s) => {
    const build = s.scenario ? SCENARIO_BUILDERS[s.scenario] : undefined;
    if (!build) return [];
    const page = build(s.sessionId);
    return [
      {
        sessionId: s.sessionId,
        title: s.title,
        lectureId: gt.lectureId,
        strokes: page.strokes,
        eraseEvents: page.eraseEvents,
        words,
        durationMs: trackMs(lecture.durationMs, page),
        hasTranscript: words.length > 0,
        labels: s.labels,
        source: "scenario" as const,
      },
    ];
  });
}
