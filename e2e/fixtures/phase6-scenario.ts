// Deterministic ink + captions for Phase 6 (gaps over time). Shared by lib/__tests__/gaps.test.ts
// and e2e/phase6.spec.ts.
//
// - A gap session is the Phase 2 gap scenario (writing from 1 s, a hesitation burst → an
//   unresolved gap at 03:40); see ./phase2-scenario.
// - A calm session starts mid-lecture and writes evenly over a stretch (e.g. 150–270 s). The first
//   two minutes of anyone's writing are their baseline, so a calm stretch never produces a moment.
import { computeBBox, inkLength, medianSpeed } from "../../lib/ink";
import type { EraseEvent, Point, Stroke, TranscriptWord } from "../../lib/types";
import { SCENARIO_TIMES, buildPhase2Scenario } from "./phase2-scenario";

export const GAP_MS = SCENARIO_TIMES.gapWindowMs;

export function buildGapScenario(sessionId: string) {
  return buildPhase2Scenario(sessionId, { correction: false });
}

function wave(x0: number, cy: number, t0: number, seed: number): Point[] {
  const durMs = 1200;
  const n = Math.round(durMs / 40);
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([
      Math.round((x0 + f * 58) * 10) / 10,
      Math.round((cy + 4 * Math.sin(2 * Math.PI * (3 + (seed % 3)) * f + seed)) * 10) / 10,
      0.5,
      Math.round(t0 + f * durMs),
    ]);
  }
  return pts;
}

/** Calm writing: one word every 2.5 s over [fromMs, toMs), nothing erased. */
export function buildCalmScenario(
  sessionId: string,
  { fromMs, toMs }: { fromMs: number; toMs: number },
): { strokes: Stroke[]; eraseEvents: EraseEvent[] } {
  const strokes: Stroke[] = [];
  for (let i = 0, t = fromMs; t < toMs; i++, t += 2500) {
    const points = wave(48 + (i % 9) * 84, 70 + Math.floor(i / 9) * 32, t, i);
    strokes.push({
      id: `${sessionId}-c${i}`,
      sessionId,
      startMs: points[0][3],
      endMs: points[points.length - 1][3],
      points,
      pointerType: "mouse",
      bbox: computeBBox(points),
      inkLen: Math.round(inkLength(points) * 10) / 10,
      medianSpeed: Math.round(medianSpeed(points) * 1000) / 1000,
      erased: false,
      erasedAtMs: null,
      erasedBy: null,
      isScribble: false,
    });
  }
  return { strokes, eraseEvents: [] };
}

const vttTime = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};

/** A WebVTT file with one cue per sentence of a word-level transcript (e.g. the demo lecture's). */
export function captionsFromWords(words: TranscriptWord[]): string {
  const cues: string[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push(`${vttTime(cur[0].startMs)} --> ${vttTime(cur[cur.length - 1].endMs)}\n${cur.map((w) => w.w).join(" ")}`);
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (/[.?!]$/.test(w.w)) flush();
  }
  flush();
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
