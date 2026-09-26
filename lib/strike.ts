// Strike-through as erasing: a straight pen line through the middle of a word, followed within
// 20 s by new writing near it, erases that word — the student crossed it out and rewrote it. The
// line alone is ambiguous (an underline, a fraction bar or a minus sign are straight lines too), so
// it stays ordinary ink until the follow-up writing confirms it; an underline below a word never
// qualifies. Nothing is hard-deleted.
//
// Stored shape once confirmed (the same as a scribble-out, see ./scribble):
//   the line:      isScribble = true, erased = true, erasedBy = 'strike', erasedAtMs = its endMs
//   struck strokes: erased = true, erasedBy = 'strike', erasedAtMs = the line's endMs
//   one EraseEvent { by: 'strike', strokeIds: struck ids, atMs: the line's endMs }
// Undo is undoScribbleOut (the line becomes an undone stroke, the word is live again).
// Pure and client-safe.
import { activeStrokes } from "./ink";
import type { ScribbleOut, ScribbleTransition } from "./scribble";
import type { BBox, Stroke } from "./types";

export const STRIKE_CONFIG = {
  /** New writing must follow the line within this long (wall-clock ms) to confirm it. */
  windowMs: 20_000,
  /** A straight line's ink length is at most this many times its end-to-end length. */
  maxBend: 1.2,
  /** Shorter lines (a tick, a minus sign) are never strike-throughs. */
  minLengthPx: 24,
  /** Steeper lines are not strike-throughs (a slash, a fraction bar drawn diagonally). */
  maxAngleDeg: 25,
  /** Narrower marks (the stem of a "+", a "1", an "l") can't be struck. */
  minWordWidthPx: 16,
  /** The line must cross this share of the word's width… */
  minCover: 0.6,
  /** …inside its middle band: the word's height minus this share at the top and at the bottom. */
  bandMargin: 0.2,
  /** Words are treated as at least this tall (a flat mark still has a middle). */
  minWordHeightPx: 12,
  /** How close the follow-up writing must land (px around the struck word and line). */
  nearPx: 48,
} as const;

const chord = (s: Stroke) => {
  const a = s.points[0];
  const b = s.points[s.points.length - 1];
  return { x0: a[0], y0: a[1], x1: b[0], y1: b[1], len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
};

/** A deliberate straight stroke, roughly horizontal (what a strike-through looks like). */
export function isStraightLine(stroke: Pick<Stroke, "points" | "inkLen">, cfg = STRIKE_CONFIG): boolean {
  if (stroke.points.length < 2) return false;
  const c = chord(stroke as Stroke);
  if (c.len < cfg.minLengthPx) return false;
  if (stroke.inkLen > cfg.maxBend * c.len) return false;
  const angle = (Math.atan2(Math.abs(c.y1 - c.y0), Math.abs(c.x1 - c.x0)) * 180) / Math.PI;
  return angle <= cfg.maxAngleDeg;
}

/**
 * Ids of the earlier live strokes `line` strikes through: it crosses at least `minCover` of a
 * stroke's width inside the stroke's middle band. Empty when `line` is not a straight line.
 */
export function detectStrikeThrough(line: Stroke, earlier: Stroke[], cfg = STRIKE_CONFIG): string[] {
  if (!isStraightLine(line, cfg)) return [];
  const c = chord(line);
  const left = Math.min(c.x0, c.x1);
  const right = Math.max(c.x0, c.x1);
  const slope = c.x1 === c.x0 ? 0 : (c.y1 - c.y0) / (c.x1 - c.x0);
  const yAt = (x: number) => c.y0 + (x - c.x0) * slope;

  const hits: string[] = [];
  for (const s of activeStrokes(earlier)) {
    if (s.id === line.id || s.erased || s.isScribble) continue;
    const [bx0, by0, bx1, by1] = s.bbox;
    const width = bx1 - bx0;
    if (width < cfg.minWordWidthPx) continue;
    const from = Math.max(left, bx0);
    const to = Math.min(right, bx1);
    if (to - from < cfg.minCover * width) continue;
    const height = Math.max(by1 - by0, cfg.minWordHeightPx);
    const cy = (by0 + by1) / 2;
    const half = height * (0.5 - cfg.bandMargin);
    const inBand = (x: number) => Math.abs(yAt(x) - cy) <= half;
    if (inBand(from) && inBand((from + to) / 2) && inBand(to)) hits.push(s.id);
  }
  return hits;
}

/** A strike-through candidate waiting for follow-up writing (client state; see SessionCapture). */
export interface PendingStrike {
  lineId: string;
  coveredIds: string[];
  /** The line and the struck strokes together. */
  bbox: BBox;
  /** Wall-clock time the line was drawn (performance.now() in the browser). */
  atMs: number;
}

export function pendingStrike(line: Stroke, coveredIds: string[], strokes: Stroke[], nowMs: number): PendingStrike | null {
  if (coveredIds.length === 0) return null;
  const covered = new Set(coveredIds);
  const bbox = strokes
    .filter((s) => covered.has(s.id))
    .reduce<BBox>(
      (a, { bbox: b }) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
      line.bbox,
    );
  return { lineId: line.id, coveredIds, bbox, atMs: nowMs };
}

/** True when `stroke` is new writing near the struck word within the time window. */
export function isStrikeFollowUp(pending: PendingStrike, stroke: Stroke, nowMs: number, cfg = STRIKE_CONFIG): boolean {
  if (stroke.id === pending.lineId || stroke.isScribble) return false;
  if (nowMs - pending.atMs > cfg.windowMs || nowMs < pending.atMs) return false;
  const [x0, y0, x1, y1] = pending.bbox;
  const pad = Math.max(cfg.nearPx, (y1 - y0) * 1.5);
  const [sx0, sy0, sx1, sy1] = stroke.bbox;
  return sx0 <= x1 + pad && sx1 >= x0 - pad && sy0 <= y1 + pad && sy1 >= y0 - pad;
}

/**
 * Confirms a strike-through: the struck strokes that are still live ink become ghost ink and the
 * line becomes an erased gesture. Null when the line or every struck stroke is gone meanwhile.
 */
export function applyStrikeOut(
  strokes: Stroke[],
  pending: Pick<PendingStrike, "lineId" | "coveredIds">,
  eventId: string,
): (ScribbleTransition & { scribble: ScribbleOut }) | null {
  const line = strokes.find((s) => s.id === pending.lineId);
  if (!line || line.erased || line.replacedBy?.length) return null;
  const live = new Set(activeStrokes(strokes).filter((s) => !s.erased && !s.isScribble).map((s) => s.id));
  const coveredIds = pending.coveredIds.filter((id) => live.has(id));
  if (coveredIds.length === 0) return null;
  const atMs = line.endMs;
  const covered = new Set(coveredIds);
  const next = strokes.map((s) => {
    if (covered.has(s.id)) return { ...s, erased: true, erasedAtMs: atMs, erasedBy: "strike" as const };
    if (s.id === line.id) return { ...s, isScribble: true, erased: true, erasedAtMs: atMs, erasedBy: "strike" as const };
    return s;
  });
  return {
    strokes: next,
    changedIds: [...coveredIds, line.id],
    event: { id: eventId, sessionId: line.sessionId, atMs, strokeIds: coveredIds, by: "strike" },
    scribble: { scribbleId: line.id, coveredIds, atMs, by: "strike" },
  };
}
