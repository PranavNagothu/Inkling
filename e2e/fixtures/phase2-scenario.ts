// Deterministic ink for Phase 2 tests (shared by lib/__tests__/analyze.test.ts and e2e/phase2.spec.ts).
//
// Handwriting is faked as small wavy "words" laid out on the notebook's 32 px ruled lines. Timeline:
//   0–200 s   steady writing, one word every 2.5 s (covers the 120 s scoring baseline)
//   ~150 s    CORRECTION: the right part of the word written at 138.5 s is rubbed out (partial erase:
//             the word is cut into a live piece + an erased piece) and rewritten in the same spot 3 s later
//   200–250 s GAP: the student stops writing while the lecture continues, erases two earlier words
//             (212 s, 222 s) without rewriting them, and scratches two slow marks far away at 221/223 s
//   250–340 s steady writing resumes on fresh lines
import { computeBBox, inkLength, medianSpeed } from "../../lib/ink";
import type { EraseEvent, Point, Stroke } from "../../lib/types";

export const WORD_W = 58;
const COL_STEP = 84;
const COLS = 9;
const LEFT = 48;
const FIRST_LINE_Y = 70;
const LINE_GAP = 32;
const WORD_MS = 1200;
const PERIOD_MS = 2500;

export const SCENARIO_TIMES = {
  correctionEraseMs: 150_000,
  rewriteMs: 153_000,
  gapEraseMs: [212_000, 222_000] as const,
  slowMarksMs: [221_000, 223_000] as const,
  resumeMs: 250_000,
  /** Scoring window where the hesitation spike lands (bucket start). */
  gapWindowMs: 220_000,
};

export function cellXY(index: number): [x: number, cy: number] {
  return [LEFT + (index % COLS) * COL_STEP, FIRST_LINE_Y + Math.floor(index / COLS) * LINE_GAP];
}

/** A wavy word-like polyline from (x0, cy) to (x0 + width, cy), sampled every ~40 ms. */
function wordPoints(x0: number, cy: number, width: number, t0: number, durMs: number, seed: number): Point[] {
  const n = Math.max(8, Math.round(durMs / 40));
  const loops = 3 + (seed % 3);
  const amp = 4 + (seed % 2);
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const x = Math.round((x0 + f * width) * 10) / 10;
    const y = Math.round((cy + amp * Math.sin(2 * Math.PI * loops * f + seed)) * 10) / 10;
    pts.push([x, y, 0.5, Math.round(t0 + f * durMs)]);
  }
  return pts;
}

function strokeFrom(id: string, sessionId: string, points: Point[], extra: Partial<Stroke> = {}): Stroke {
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

function word(sessionId: string, index: number, t0: number, durMs = WORD_MS, cell = index): Stroke {
  const [x, cy] = cellXY(cell);
  return strokeFrom(`${sessionId}-w${index}`, sessionId, wordPoints(x, cy, WORD_W, t0, durMs, index));
}

export interface ScenarioOptions {
  correction?: boolean;
  gap?: boolean;
}

/** Index of the word (written at 138.5 s) whose right part gets corrected. */
export const CORRECTED_WORD = 55;
/** Words erased without a rewrite during the gap. */
export const GAP_ERASED_WORDS = [78, 79] as const;

export function buildPhase2Scenario(
  sessionId: string,
  { correction = true, gap = true }: ScenarioOptions = {},
): { strokes: Stroke[]; eraseEvents: EraseEvent[] } {
  const strokes: Stroke[] = [];
  const eraseEvents: EraseEvent[] = [];

  // Steady writing, 0–200 s.
  for (let i = 0; 1000 + i * PERIOD_MS < 200_000; i++) strokes.push(word(sessionId, i, 1000 + i * PERIOD_MS));

  if (correction) {
    // Partial erase of the right 60% of the word, then a rewrite over the rubbed-out part.
    const parentIdx = strokes.findIndex((s) => s.id === `${sessionId}-w${CORRECTED_WORD}`);
    const parent = strokes[parentIdx];
    const cut = Math.round(parent.points.length * 0.4);
    const at = SCENARIO_TIMES.correctionEraseMs;
    const live = strokeFrom(`${parent.id}-a`, sessionId, parent.points.slice(0, cut + 1), { splitFrom: parent.id });
    const erased = strokeFrom(`${parent.id}-b`, sessionId, parent.points.slice(cut), {
      splitFrom: parent.id,
      erased: true,
      erasedAtMs: at,
      erasedBy: "eraser",
    });
    strokes[parentIdx] = { ...parent, replacedBy: [live.id, erased.id] };
    strokes.push(live, erased);
    eraseEvents.push({ id: `${sessionId}-e-corr`, sessionId, atMs: at, strokeIds: [erased.id], by: "eraser" });

    const [, cy] = cellXY(CORRECTED_WORD);
    const x0 = erased.bbox[0];
    const rewrite = wordPoints(x0, cy, erased.bbox[2] - x0, SCENARIO_TIMES.rewriteMs, WORD_MS, 7);
    strokes.push(strokeFrom(`${sessionId}-rewrite`, sessionId, rewrite));
  }

  if (gap) {
    GAP_ERASED_WORDS.forEach((idx, k) => {
      const at = SCENARIO_TIMES.gapEraseMs[k];
      const i = strokes.findIndex((s) => s.id === `${sessionId}-w${idx}`);
      strokes[i] = { ...strokes[i], erased: true, erasedAtMs: at, erasedBy: "eraser" };
      eraseEvents.push({ id: `${sessionId}-e-gap${k}`, sessionId, atMs: at, strokeIds: [strokes[i].id], by: "eraser" });
    });
    // Two slow, hesitant marks on a fresh line, far from the erased words (so they are not rewrites).
    SCENARIO_TIMES.slowMarksMs.forEach((t0, k) => {
      const [x, cy] = cellXY(9 * COLS + k);
      strokes.push(strokeFrom(`${sessionId}-slow${k}`, sessionId, wordPoints(x, cy, WORD_W, t0, 4000, 20 + k)));
    });
  }

  // Steady writing resumes, 250–340 s, starting on a fresh line.
  const firstResumeCell = 10 * COLS;
  for (let j = 0; SCENARIO_TIMES.resumeMs + j * PERIOD_MS < 340_000; j++) {
    const t0 = SCENARIO_TIMES.resumeMs + j * PERIOD_MS;
    strokes.push(word(sessionId, 1000 + j, t0, WORD_MS, firstResumeCell + j));
  }

  return { strokes, eraseEvents };
}

/** A calm session: a handful of evenly paced words, nothing erased. */
export function buildSteadyScenario(sessionId: string, count = 6): { strokes: Stroke[]; eraseEvents: EraseEvent[] } {
  const strokes: Stroke[] = [];
  for (let i = 0; i < count; i++) strokes.push(word(sessionId, i, 1000 + i * PERIOD_MS));
  return { strokes, eraseEvents: [] };
}
