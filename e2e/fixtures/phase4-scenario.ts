// Deterministic ink for Phase 4 (short uploaded lectures): a few steady words, then one word is
// partly rubbed out at `eraseMs` and rewritten in the same spot 2 s later — a single corrected
// misconception at `eraseMs`. Shared by lib/__tests__/lecture.test.ts and e2e/phase4.spec.ts.
import { computeBBox, inkLength, medianSpeed } from "../../lib/ink";
import type { EraseEvent, Point, Stroke } from "../../lib/types";

const LEFT = 60;
const TOP = 90;
const STEP_X = 90;
const WIDTH = 60;

function wave(x0: number, cy: number, width: number, t0: number, durMs: number, seed: number): Point[] {
  const n = Math.max(8, Math.round(durMs / 40));
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([
      Math.round((x0 + f * width) * 10) / 10,
      Math.round((cy + 5 * Math.sin(2 * Math.PI * (3 + (seed % 2)) * f + seed)) * 10) / 10,
      0.5,
      Math.round(t0 + f * durMs),
    ]);
  }
  return pts;
}

function stroke(id: string, sessionId: string, points: Point[], extra: Partial<Stroke> = {}): Stroke {
  return {
    id,
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
    ...extra,
  };
}

export function buildCorrectionScenario(
  sessionId: string,
  { eraseMs = 20_000, words = 5 }: { eraseMs?: number; words?: number } = {},
): { strokes: Stroke[]; eraseEvents: EraseEvent[] } {
  const strokes: Stroke[] = [];
  for (let i = 0; i < words; i++) {
    strokes.push(stroke(`${sessionId}-w${i}`, sessionId, wave(LEFT + i * STEP_X, TOP, WIDTH, 1000 + i * 2500, 1200, i)));
  }
  // Partially erase the second word (written at 3.5 s, so well over the 3 s "slip" age).
  const parent = strokes[1];
  const cut = Math.round(parent.points.length * 0.4);
  const live = stroke(`${parent.id}-a`, sessionId, parent.points.slice(0, cut + 1), { splitFrom: parent.id });
  const erased = stroke(`${parent.id}-b`, sessionId, parent.points.slice(cut), {
    splitFrom: parent.id,
    erased: true,
    erasedAtMs: eraseMs,
    erasedBy: "eraser",
  });
  strokes[1] = { ...parent, replacedBy: [live.id, erased.id] };
  strokes.push(live, erased);
  const x0 = erased.bbox[0];
  strokes.push(stroke(`${sessionId}-rewrite`, sessionId, wave(x0, TOP, erased.bbox[2] - x0, eraseMs + 2000, 1200, 7)));
  return {
    strokes,
    eraseEvents: [{ id: `${sessionId}-e1`, sessionId, atMs: eraseMs, strokeIds: [erased.id], by: "eraser" }],
  };
}
