// Signal Lab data shaping: a session's stored analysis (lib/analyze getTimeline) → what the chart
// draws — the four hesitation features and both scores per 10 s window, the spike threshold, the
// baseline stretches and the timeline moments, with each spike linked to the moment it produced.
// Pure; safe on client and server.
import { MOMENT_META } from "./moments";
import { SCORING_CONFIG } from "./scoring";
import { formatClock } from "./time";
import type { TimeRange, TimelineData, TimelineEvent, TimelineEventType, WindowPhase } from "./types";

export type FeatureKey = "pause" | "slowdown" | "erase" | "pressure";

/** The four signals, in the scoring engine's order, with plain-language explanations. */
export const FEATURES: Array<{ key: FeatureKey; label: string; weight: number; explain: string }> = [
  {
    key: "pause",
    label: "Pause",
    weight: SCORING_CONFIG.weights.pause,
    explain: `You stopped writing for ${SCORING_CONFIG.pauseGapMs / 1000} s or more while the lecturer kept talking.`,
  },
  {
    key: "slowdown",
    label: "Slowdown",
    weight: SCORING_CONFIG.weights.slowdown,
    explain: "Your pen moved slower than your own usual speed.",
  },
  {
    key: "erase",
    label: "Erase",
    weight: SCORING_CONFIG.weights.erase,
    explain: "You erased more than you usually do.",
  },
  {
    key: "pressure",
    label: "Pressure",
    weight: SCORING_CONFIG.weights.pressure,
    explain: "You pressed harder than usual (only with a pressure-sensitive pen).",
  },
];

export interface SignalPoint {
  startMs: number;
  endMs: number;
  midMs: number;
  phase: WindowPhase;
  pause: number;
  slowdown: number;
  erase: number;
  pressure: number | null;
  rawScore: number;
  /** The smoothed score spikes are judged on (emaScore). */
  score: number;
  isSpike: boolean;
  reasons: string[];
  /** Features at or above the "on" level, in FEATURES order. */
  featuresOn: FeatureKey[];
  /** The moment a spike produced (null for other windows, or a spike whose moment was merged away). */
  eventId: string | null;
  eventType: TimelineEventType | null;
  /** Why a window at or above the threshold was not flagged (null otherwise). */
  note: string | null;
}

export interface SignalMarker {
  id: string;
  type: TimelineEventType;
  status: TimelineEvent["status"];
  lectureMs: number;
  label: string;
}

export interface SignalLabData {
  durationMs: number;
  windowMs: number;
  spikeScore: number;
  featureOn: number;
  minFeaturesOn: number;
  points: SignalPoint[];
  markers: SignalMarker[];
  baseline: TimeRange[];
  /** Total lecture time the baseline was measured over. */
  baselineMs: number;
  pressureUsed: boolean;
  spikeCount: number;
  /** The window with the highest smoothed score among scored windows (null when none). */
  peak: SignalPoint | null;
}

const LINK_TOLERANCE_MS = 15_000;

export function shapeSignalLab(
  timeline: Pick<TimelineData, "durationMs" | "windows" | "events" | "baseline">,
  cfg: {
    windowMs: number;
    spikeScore: number;
    featureOn: number;
    minFeaturesOn: number;
    refractoryMs: number;
    maxSpikes: number;
  } = SCORING_CONFIG,
): SignalLabData {
  const { durationMs, events, baseline } = timeline;
  const byWindow = new Map(events.filter((e) => e.windowStartMs !== undefined).map((e) => [e.windowStartMs!, e]));
  const nearestEvent = (ms: number): TimelineEvent | undefined => {
    let best: TimelineEvent | undefined;
    for (const e of events) {
      const d = Math.abs(e.lectureMs - ms);
      if (d <= LINK_TOLERANCE_MS && (!best || d < Math.abs(best.lectureMs - ms))) best = e;
    }
    return best;
  };

  const points: SignalPoint[] = [...timeline.windows]
    .sort((a, b) => a.bucketStartMs - b.bucketStartMs)
    .map((w) => {
      const startMs = w.bucketStartMs;
      const endMs = durationMs > startMs ? Math.min(startMs + cfg.windowMs, durationMs) : startMs + cfg.windowMs;
      const midMs = (startMs + endMs) / 2;
      const featuresOn = FEATURES.filter((f) => {
        const v = w[f.key];
        return v !== null && v >= cfg.featureOn;
      }).map((f) => f.key);
      const linked = w.isSpike ? byWindow.get(startMs) ?? nearestEvent(midMs) : undefined;
      return {
        startMs,
        endMs,
        midMs,
        phase: w.phase ?? "scored",
        pause: w.pause,
        slowdown: w.slowdown,
        erase: w.erase,
        pressure: w.pressure,
        rawScore: w.rawScore,
        score: w.emaScore,
        isSpike: w.isSpike,
        reasons: [...w.reasons],
        featuresOn,
        eventId: linked?.id ?? null,
        eventType: linked?.type ?? null,
        note: null as string | null,
      };
    });

  // Above the line but not flagged: say which rule held it back (mirrors lib/scoring's spike rules).
  for (const p of points) {
    if (p.isSpike || p.score < cfg.spikeScore || p.phase === "idle") continue;
    if (p.phase === "baseline") p.note = "Above the line, but in the baseline — never flagged";
    else if (p.featuresOn.length < cfg.minFeaturesOn) {
      const n = p.featuresOn.length;
      p.note = `Above the line, but only ${n} signal${n === 1 ? "" : "s"} on (needs ${cfg.minFeaturesOn})`;
    } else if (points.some((q) => q.isSpike && q.startMs < p.startMs && p.startMs - q.startMs < cfg.refractoryMs)) {
      p.note = `Above the line, but within ${cfg.refractoryMs / 1000} s of the last spike`;
    } else p.note = `Above the line, but not among the top ${cfg.maxSpikes} of the session`;
  }

  const markers: SignalMarker[] = [...events]
    .sort((a, b) => a.lectureMs - b.lectureMs)
    .map((e) => ({
      id: e.id,
      type: e.type,
      status: e.status,
      lectureMs: e.lectureMs,
      label: e.conceptLabel || MOMENT_META[e.type].label,
    }));

  let peak: SignalPoint | null = null;
  for (const p of points) if (p.phase === "scored" && p.score > 0 && (!peak || p.score > peak.score)) peak = p;

  return {
    durationMs,
    windowMs: cfg.windowMs,
    spikeScore: cfg.spikeScore,
    featureOn: cfg.featureOn,
    minFeaturesOn: cfg.minFeaturesOn,
    points,
    markers,
    baseline: baseline.map((z) => ({ ...z })),
    baselineMs: baseline.reduce((n, z) => n + Math.max(0, z.endMs - z.startMs), 0),
    pressureUsed: points.some((p) => p.pressure !== null),
    spikeCount: points.filter((p) => p.isSpike).length,
    peak,
  };
}

/** Review page for a session, opened on a moment when there is one. */
export function reviewHref(sessionId: string, eventId: string | null): string {
  const base = `/review/${encodeURIComponent(sessionId)}`;
  return eventId ? `${base}?moment=${encodeURIComponent(eventId)}` : base;
}

const TICK_STEPS_MS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

/** Round lecture-clock tick positions from 0 with at most `maxIntervals` intervals. */
export function timeTicks(durationMs: number, maxIntervals = 7): number[] {
  if (durationMs <= 0) return [0];
  const step = TICK_STEPS_MS.find((s) => durationMs / s <= maxIntervals) ?? Math.ceil(durationMs / maxIntervals / 60_000) * 60_000;
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += step) ticks.push(t);
  return ticks;
}

export const formatScore = (n: number): string => n.toFixed(2);

const PHASE_TEXT: Record<WindowPhase, string> = {
  idle: "not taking notes (not scored)",
  baseline: "baseline — calibrating your normal (never flagged)",
  scored: "scored",
};

/** One window read aloud (screen readers, the keyboard live region). */
export function describePoint(p: SignalPoint, spikeScore: number): string {
  const range = `${formatClock(p.startMs)}–${formatClock(p.endMs)}`;
  if (p.phase === "idle") return `${range}: ${PHASE_TEXT.idle}.`;
  const vs = p.score >= spikeScore ? "above" : "below";
  const feats = FEATURES.map((f) => {
    const v = p[f.key];
    return `${f.label.toLowerCase()} ${v === null ? "n/a" : formatScore(v)}`;
  }).join(", ");
  const parts = [
    `${range}: score ${formatScore(p.score)}, ${vs} the ${formatScore(spikeScore)} threshold`,
    p.isSpike ? "spike — flagged as stuck" : p.note ?? PHASE_TEXT[p.phase],
    feats,
  ];
  if (p.reasons.length) parts.push(`why: ${p.reasons.join("; ")}`);
  return `${parts.join(". ")}.`;
}
