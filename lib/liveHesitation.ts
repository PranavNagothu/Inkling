// Live hesitation meter (capture screen): how the last ~20 s of pen activity compares with the
// student's own baseline — the same three signals the post-session scoring uses (./scoring):
// writing slower than usual, erasing more than usual, and a silence while the lecturer keeps
// talking. Pure and cheap (one pass over the strokes); the capture screen recomputes it when ink
// changes and on a slow timer, never per pointer move.
import { activeStrokes } from "./ink";
import { SCORING_CONFIG, median } from "./scoring";
import type { Stroke, TranscriptWord } from "./types";

export const LIVE_HESITATION = {
  /** The stretch of recent activity compared with the baseline. */
  recentMs: 20_000,
  /** The student's own first writing that calibrates "usual" (as in post-session scoring). */
  baselineMs: SCORING_CONFIG.baselineMs,
  /** Strokes needed before the meter says anything. */
  minBaselineStrokes: 6,
  /** Recent strokes needed to judge speed. */
  minRecentStrokes: 2,
  /** A silence shorter than this is just a breath (post-session: pauseGapMs). */
  pauseGapMs: SCORING_CONFIG.pauseGapMs,
  /** The lecturer must have said this many words during the silence (post-session: minWordsForPause). */
  minWordsForPause: SCORING_CONFIG.minWordsForPause,
  /** A silence this long (past the gap) counts fully. */
  pauseFullMs: 24_000,
  /** Erase moments above the usual count that count fully. */
  eraseFull: 2,
  slowingAt: 0.3,
  /** Same threshold as a post-session hesitation spike. */
  stuckAt: SCORING_CONFIG.spikeScore,
} as const;

export type MeterState = "calibrating" | "steady" | "slowing" | "stuck";

export interface LiveHesitation {
  state: MeterState;
  /** 0..1 */
  level: number;
  /** Plain-language reasons (for the tooltip / screen readers). */
  reasons: string[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// Pressure is left out live (its variance check needs the whole baseline); the other three
// weights are rescaled to sum to 1, as scoring does when pressure is unusable.
const W = (() => {
  const { pause, slowdown, erase } = SCORING_CONFIG.weights;
  const sum = pause + slowdown + erase;
  return { pause: pause / sum, slowdown: slowdown / sum, erase: erase / sum };
})();

export function liveHesitation(input: {
  strokes: Stroke[];
  words: TranscriptWord[];
  /** Current lecture time (ms). */
  nowMs: number;
  config?: Partial<typeof LIVE_HESITATION>;
}): LiveHesitation {
  const cfg = { ...LIVE_HESITATION, ...input.config };
  const { nowMs, words } = input;
  const page = activeStrokes(input.strokes);
  // Ink the student wrote and kept (erased ink still shows how fast they wrote it).
  const ink = page.filter((s) => !s.isScribble && s.erasedBy !== "undo").sort((a, b) => a.startMs - b.startMs);
  if (ink.length < cfg.minBaselineStrokes) return { state: "calibrating", level: 0, reasons: [] };

  // Baseline: the first `baselineMs` of their writing (at least minBaselineStrokes strokes).
  const baseStart = ink[0].startMs;
  let baseline = ink.filter((s) => s.startMs < baseStart + cfg.baselineMs);
  if (baseline.length < cfg.minBaselineStrokes) baseline = ink.slice(0, cfg.minBaselineStrokes);
  const baseSpeeds = baseline.map((s) => s.medianSpeed).filter((v) => v > 0);
  const baseSpeed = baseSpeeds.length ? median(baseSpeeds) : 0;
  const baseSpan = Math.max(cfg.recentMs, baseline[baseline.length - 1].endMs - baseStart);
  const eraseMoments = (list: Stroke[], from: number, to: number) =>
    new Set(
      list
        .filter((s) => s.erased && s.erasedBy !== "undo" && s.erasedAtMs != null && s.erasedAtMs > from && s.erasedAtMs <= to)
        .map((s) => Math.round(s.erasedAtMs! / 1000)),
    ).size;
  const usualErases = (eraseMoments(ink, baseStart - 1, baseStart + baseSpan) / baseSpan) * cfg.recentMs;

  const from = nowMs - cfg.recentMs;
  const recent = ink.filter((s) => s.startMs > from && s.startMs <= nowMs);
  const reasons: string[] = [];

  let slowdown = 0;
  if (recent.length >= cfg.minRecentStrokes && baseSpeed > 0) {
    slowdown = clamp01(1 - median(recent.map((s) => s.medianSpeed)) / baseSpeed);
    if (slowdown >= 0.4) reasons.push(`writing ${Math.round(slowdown * 100)}% slower than usual`);
  }

  const erasesNow = eraseMoments(ink, from, nowMs);
  const erase = clamp01((erasesNow - usualErases) / cfg.eraseFull);
  if (erase > 0 && erasesNow > 0) reasons.push(`erased ${erasesNow}× in the last ${Math.round(cfg.recentMs / 1000)} s`);

  let pause = 0;
  const written = ink.filter((s) => s.startMs <= nowMs);
  if (written.length > 0) {
    const lastEnd = Math.max(...written.map((s) => s.endMs));
    const idle = nowMs - lastEnd;
    if (idle >= cfg.pauseGapMs) {
      const spoken = words.filter((w) => w.startMs > lastEnd && w.startMs <= nowMs).length;
      if (spoken >= cfg.minWordsForPause) {
        pause = clamp01(0.4 + ((idle - cfg.pauseGapMs) / cfg.pauseFullMs) * 0.6);
        reasons.push(`paused ${Math.round(idle / 1000)} s while the lecture kept going`);
      }
    }
  }

  const level = clamp01(W.slowdown * slowdown + W.erase * erase + W.pause * pause);
  const state: MeterState = level >= cfg.stuckAt ? "stuck" : level >= cfg.slowingAt ? "slowing" : "steady";
  return { state, level: Math.round(level * 100) / 100, reasons };
}
