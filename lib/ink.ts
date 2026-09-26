// Pure ink geometry helpers. Safe to import from client and server code.
import type { BBox, Point, Stroke } from "./types";

export function computeBBox(points: Point[]): BBox {
  if (points.length === 0) return [0, 0, 0, 0];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Total polyline length in px. */
export function inkLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

/**
 * Median per-segment speed in px/ms. Segments with non-positive dt are skipped
 * (coalesced events can share a timestamp). Returns 0 when not computable.
 */
export function medianSpeed(points: Point[]): number {
  const speeds: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = points[i][3] - points[i - 1][3];
    if (dt <= 0) continue;
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    speeds.push(d / dt);
  }
  if (speeds.length === 0) return 0;
  speeds.sort((a, b) => a - b);
  const mid = Math.floor(speeds.length / 2);
  return speeds.length % 2 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The strokes that currently exist on the page: every stroke that has not been cut into pieces
 * by a partial erase. Includes erased (ghost) leaves as well as live ink.
 */
export function activeStrokes<T extends Pick<Stroke, "replacedBy">>(strokes: T[]): T[] {
  return strokes.filter((s) => !s.replacedBy?.length);
}

/** What the student drew, counted in lines rather than stored pieces (see inkCounts). */
export interface InkCounts {
  /** Lines the student actually drew: root strokes, minus erasing gestures and undone strokes. */
  drawn: number;
  /** Erased ink kept as ghost: erased leaves (pieces count individually), minus gestures and undone strokes. */
  erasedParts: number;
}

type CountableStroke = Pick<Stroke, "splitFrom" | "replacedBy" | "isScribble" | "erased" | "erasedBy">;

/** A root the student drew and kept (not an erasing gesture, not taken back with Undo). */
export const isDrawnStroke = (s: CountableStroke) =>
  !s.splitFrom && !s.isScribble && !(s.erased && s.erasedBy === "undo");

/** A leaf of erased ink (a whole stroke or a piece), not a gesture, not undone. */
export const isErasedPart = (s: CountableStroke) =>
  !s.replacedBy?.length && s.erased && !s.isScribble && s.erasedBy !== "undo";

/**
 * Stroke counter for people: rubbing the middle out of one line is "1 stroke · 1 erased part", not
 * "2 strokes · 1 ghost". Same rules as the SQL behind Db.sessionStrokeCounts (home page list).
 */
export function inkCounts(strokes: CountableStroke[]): InkCounts {
  let drawn = 0;
  let erasedParts = 0;
  for (const s of strokes) {
    if (isDrawnStroke(s)) drawn++;
    if (isErasedPart(s)) erasedParts++;
  }
  return { drawn, erasedParts };
}

/** "1 stroke · 1 erased part" (the erased part is left out when there is none). */
export function inkCountsLabel({ drawn, erasedParts }: InkCounts): { strokes: string; erased: string | null } {
  return {
    strokes: `${drawn} ${drawn === 1 ? "stroke" : "strokes"}`,
    erased: erasedParts > 0 ? `${erasedParts} erased ${erasedParts === 1 ? "part" : "parts"}` : null,
  };
}

export type XY = [number, number];

export interface SplitResult {
  /**
   * The touched stroke as it should now be stored: `replacedBy` set to the piece ids, or — when the
   * eraser covered all of it — the stroke itself marked erased in place.
   */
  parent: Stroke;
  /** Leaf strokes that take the parent's place on the page (just `[parent]` when erased in place). */
  pieces: Stroke[];
}

/** Kept (live) runs shorter than this are visually negligible and are not turned into pieces. */
const MIN_KEPT_INK_PX = 1;

/** Rounds to `places` decimals (matches how capture stores inkLen / medianSpeed). */
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

function lerpPoint(a: Point, b: Point, t: number): Point {
  return [
    Math.round((a[0] + (b[0] - a[0]) * t) * 10) / 10,
    Math.round((a[1] + (b[1] - a[1]) * t) * 10) / 10,
    Math.round((a[2] + (b[2] - a[2]) * t) * 1000) / 1000,
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

function makePiece(parent: Stroke, points: Point[], erased: boolean, atMs: number, id: string): Stroke {
  return {
    id,
    sessionId: parent.sessionId,
    startMs: points[0][3],
    endMs: points[points.length - 1][3],
    points,
    pointerType: parent.pointerType,
    bbox: computeBBox(points),
    inkLen: round(inkLength(points), 1),
    medianSpeed: round(medianSpeed(points), 3),
    erased,
    erasedAtMs: erased ? atMs : null,
    erasedBy: erased ? "eraser" : null,
    isScribble: parent.isScribble,
    splitFrom: parent.id,
    replacedBy: null,
  };
}

/**
 * Real-eraser semantics: cuts `stroke` where the eraser (a circle of `radius` swept along
 * `eraserPath`, so fast drags between samples still count) passes over it. Returns null when the
 * eraser does not touch the live stroke.
 *
 * The stroke is split into contiguous runs, with interpolated points inserted where it crosses the
 * eraser's edge. Runs outside the eraser become live pieces; runs inside become erased pieces
 * (erasedBy 'eraser', erasedAtMs = atMs). The parent gets `replacedBy` = piece ids and is kept for
 * history. When the eraser covers the whole stroke (no non-negligible live run remains) the stroke
 * is instead marked erased in place, exactly like the old whole-stroke eraser.
 */
export function splitStrokeByEraser(
  stroke: Stroke,
  eraserPath: XY[],
  radius: number,
  atMs: number,
  newId: () => string,
): SplitResult | null {
  const pts = stroke.points;
  if (stroke.erased || stroke.replacedBy?.length || eraserPath.length === 0 || pts.length === 0) return null;

  // Eraser path as capsule segments, keeping only those that can reach this stroke.
  const [bx0, by0, bx1, by1] = stroke.bbox;
  const segs: number[] = [];
  const addSeg = (a: XY, b: XY) => {
    if (Math.max(a[0], b[0]) < bx0 - radius || Math.min(a[0], b[0]) > bx1 + radius) return;
    if (Math.max(a[1], b[1]) < by0 - radius || Math.min(a[1], b[1]) > by1 + radius) return;
    segs.push(a[0], a[1], b[0], b[1]);
  };
  if (eraserPath.length === 1) addSeg(eraserPath[0], eraserPath[0]);
  for (let i = 1; i < eraserPath.length; i++) addSeg(eraserPath[i - 1], eraserPath[i]);
  if (segs.length === 0) return null;

  const inside = (x: number, y: number) => {
    for (let k = 0; k < segs.length; k += 4) {
      if (distToSegment(x, y, segs[k], segs[k + 1], segs[k + 2], segs[k + 3]) <= radius) return true;
    }
    return false;
  };

  // Walk the polyline in small sub-steps so an eraser crossing between two sparse points is caught,
  // bisecting each in/out transition to place a clean boundary point.
  const step = Math.max(0.5, radius / 4);
  const runs: Array<{ erased: boolean; points: Point[] }> = [];
  let cur = { erased: inside(pts[0][0], pts[0][1]), points: [pts[0]] };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    let prevT = 0;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const now = inside(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (now !== cur.erased) {
        let lo = prevT;
        let hi = t;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2;
          if (inside(a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid) === cur.erased) lo = mid;
          else hi = mid;
        }
        const edge = lerpPoint(a, b, (lo + hi) / 2);
        cur.points.push(edge);
        runs.push(cur);
        cur = { erased: now, points: [edge] };
      }
      prevT = t;
    }
    cur.points.push(b);
  }
  runs.push(cur);

  if (!runs.some((r) => r.erased)) return null;
  const keep = runs.filter((r) => r.erased || inkLength(r.points) >= MIN_KEPT_INK_PX);
  if (!keep.some((r) => !r.erased)) {
    const parent: Stroke = { ...stroke, erased: true, erasedAtMs: atMs, erasedBy: "eraser" };
    return { parent, pieces: [parent] };
  }
  const pieces = keep.map((r) => makePiece(stroke, r.points, r.erased, atMs, newId()));
  return { parent: { ...stroke, replacedBy: pieces.map((p) => p.id) }, pieces };
}

/** A fresh live pen stroke from captured points (timing, bbox and metrics derived from them). */
export function buildStroke(id: string, sessionId: string, points: Point[], pointerType: Stroke["pointerType"]): Stroke {
  return {
    id,
    sessionId,
    startMs: points[0][3],
    endMs: points[points.length - 1][3],
    points,
    pointerType,
    bbox: computeBBox(points),
    inkLen: round(inkLength(points), 1),
    medianSpeed: round(medianSpeed(points), 3),
    erased: false,
    erasedAtMs: null,
    erasedBy: null,
    isScribble: false,
  };
}

/** Random id that works outside secure contexts (crypto.randomUUID needs https on iPad over LAN). */
export function newId(prefix = ""): string {
  const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
