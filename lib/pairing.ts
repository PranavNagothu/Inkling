// Erase -> correction pairing logic. Groups erased strokes into EraseGroups,
// finds the strokes that were drawn afterward to "fix" the erased region, and
// emits Revision records the rest of the app can reason about.
//
// All times are lecture-clock ms (see ../types).

import type { BBox, EraseEvent, Revision, RevisionKind, Stroke } from './types';
import { activeStrokes } from './ink';

export const PAIRING_CONFIG = {
  eraseGroupGapMs: 3000,
  padMinPx: 24,
  padFrac: 0.15,
  correctionWindowMs: 20000,
  continueGapMs: 4000,
  maxWindowMs: 45000,
  minOverlap: 0.3,
  minErasedInkPx: 40,
  microAgeMs: 3000,
  chainWindowMs: 60000,
} as const;

export type PairingConfig = typeof PAIRING_CONFIG;

// ---------------------------------------------------------------------------
// bbox helpers
// ---------------------------------------------------------------------------

function bboxArea(b: BBox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function bboxDiagonal(b: BBox): number {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  return Math.sqrt(w * w + h * h);
}

function unionBBoxes(boxes: BBox[]): BBox {
  return boxes.reduce<BBox>(
    (acc, b) => [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])],
    boxes[0],
  );
}

function padBBox(b: BBox, padMinPx: number, padFrac: number): BBox {
  const pad = Math.max(padMinPx, padFrac * bboxDiagonal(b));
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

function boxesIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function intersectArea(a: BBox, b: BBox): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return ix * iy;
}

/** overlap = intersectionArea / min(areaA, areaB), per spec. */
function overlapRatio(a: BBox, b: BBox): number {
  const areaA = bboxArea(a);
  const areaB = bboxArea(b);
  const minArea = Math.min(areaA, areaB);
  if (minArea <= 0) return 0;
  return intersectArea(a, b) / minArea;
}

// ---------------------------------------------------------------------------
// detectScribble
// ---------------------------------------------------------------------------

export const SCRIBBLE_CONFIG = {
  /** inkLen / bbox diagonal must exceed this (an underline is ~1, handwriting ~2-4). */
  minWiggleRatio: 4,
  /** Big direction reversals needed along the scribble's dominant axis. */
  minReversals: 4,
  /** A swing only counts as a reversal when it travels at least this share of the bbox extent... */
  swingFrac: 0.25,
  /** ...and at least this many px (so sensor jitter / 0.1 px rounding never counts). */
  minSwingPx: 4,
  /** Share of an earlier stroke's bbox that the scribble's bbox must cover. */
  minBBoxCover: 0.5,
  /** Share of an earlier stroke's ink that must lie within `hitRadiusPx` of the scribble's ink. */
  minInkCover: 0.5,
  hitRadiusPx: 12,
  /** Earlier strokes' bboxes are at least 2× this wide/tall (≈ line width), so a dead-straight line or a dot has area. */
  candidatePadPx: 2,
} as const;

/** Grows any side of `b` shorter than `min` to `min` (about its centre). */
function withMinExtent(b: BBox, min: number): BBox {
  const grow = (lo: number, hi: number): [number, number] => {
    const d = hi - lo;
    return d >= min ? [lo, hi] : [lo - (min - d) / 2, hi + (min - d) / 2];
  };
  const [x0, x1] = grow(b[0], b[2]);
  const [y0, y1] = grow(b[1], b[3]);
  return [x0, y0, x1, y1];
}

/**
 * Direction reversals along one axis with hysteresis: the pen must travel back at least `minSwing`
 * from its furthest point before a reversal counts. Tiny wobbles (sensor jitter, a letter's loop
 * inside a wide word) are ignored; the full-width back-and-forth of a scribble is counted.
 */
export function countReversals(points: Stroke['points'], axis: 0 | 1, minSwing: number): number {
  if (points.length < 2) return 0;
  let count = 0;
  let dir = 0; // +1 / -1 once the pen has moved minSwing in some direction
  let extreme = points[0][axis];
  for (let i = 1; i < points.length; i++) {
    const v = points[i][axis];
    if (dir === 0) {
      if (Math.abs(v - extreme) >= minSwing) {
        dir = v > extreme ? 1 : -1;
        extreme = v;
      }
      continue;
    }
    if ((dir > 0 && v > extreme) || (dir < 0 && v < extreme)) {
      extreme = v;
    } else if (Math.abs(v - extreme) >= minSwing) {
      count++;
      dir = -dir;
      extreme = v;
    }
  }
  return count;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Points every ~`step` px along a polyline (always includes the vertices). Capped for long strokes. */
function samplePolyline(points: Stroke['points'], step: number, max = 400): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (points.length === 0) return out;
  out.push([points[0][0], points[0][1]]);
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (out.length <= max) return out;
  const stride = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * stride)]);
}

/** Share of `candidate`'s ink that lies within `radius` of the scribble polyline. */
function inkCoverage(scribble: Stroke['points'], candidate: Stroke['points'], radius: number): number {
  const samples = samplePolyline(candidate, 3);
  if (samples.length === 0) return 0;
  let hit = 0;
  for (const [x, y] of samples) {
    if (scribble.length === 1) {
      if (Math.hypot(scribble[0][0] - x, scribble[0][1] - y) <= radius) hit++;
      continue;
    }
    for (let i = 1; i < scribble.length; i++) {
      const [ax, ay] = scribble[i - 1];
      const [bx, by] = scribble[i];
      // Cheap reject before the exact distance.
      if (x < Math.min(ax, bx) - radius || x > Math.max(ax, bx) + radius) continue;
      if (y < Math.min(ay, by) - radius || y > Math.max(ay, by) + radius) continue;
      if (distToSegment(x, y, ax, ay, bx, by) <= radius) {
        hit++;
        break;
      }
    }
  }
  return hit / samples.length;
}

/**
 * True when the stroke's *shape* is a scribble: long/wiggly relative to its own bbox
 * (inkLen/diagonal > minWiggleRatio — a near-straight underline is ~1) AND it swings back and forth
 * at least minReversals times along its dominant axis (horizontal back-and-forth, or a vertical
 * zig-zag / loop chain moving across the word).
 */
export function isScribbleShape(stroke: Pick<Stroke, 'bbox' | 'inkLen' | 'points'>, cfg = SCRIBBLE_CONFIG): boolean {
  const diag = bboxDiagonal(stroke.bbox);
  if (diag <= 0) return false;
  if (stroke.inkLen / diag <= cfg.minWiggleRatio) return false;
  const w = stroke.bbox[2] - stroke.bbox[0];
  const h = stroke.bbox[3] - stroke.bbox[1];
  const rx = countReversals(stroke.points, 0, Math.max(cfg.minSwingPx, cfg.swingFrac * w));
  const ry = countReversals(stroke.points, 1, Math.max(cfg.minSwingPx, cfg.swingFrac * h));
  return Math.max(rx, ry) >= cfg.minReversals;
}

/**
 * Returns the ids of the earlier, still-visible strokes that `stroke` scribbles out (empty when it
 * is ordinary writing). The shape test (isScribbleShape) is deliberately loose; what makes it a
 * scribble-*out* is that it lands on existing ink: its bbox covers >= 50% of the earlier stroke's
 * (padded) bbox AND its ink passes within hitRadiusPx of >= 50% of that stroke's ink. The ink test
 * keeps shading inside a drawn shape, or a zig-zag whose bbox merely reaches a nearby mark, from
 * swallowing strokes it never actually crossed.
 */
export function detectScribble(stroke: Stroke, earlier: Stroke[], cfg = SCRIBBLE_CONFIG): string[] {
  if (!isScribbleShape(stroke, cfg)) return [];

  const hits: string[] = [];
  for (const candidate of earlier) {
    if (candidate.erased || candidate.id === stroke.id) continue;
    const box = withMinExtent(candidate.bbox, 2 * cfg.candidatePadPx);
    const covered = intersectArea(stroke.bbox, box) / bboxArea(box);
    if (covered < cfg.minBBoxCover) continue;
    if (inkCoverage(stroke.points, candidate.points, cfg.hitRadiusPx) < cfg.minInkCover) continue;
    hits.push(candidate.id);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// erase grouping
// ---------------------------------------------------------------------------

/** An erased stroke that can be part of a revision (it has an erase time). */
type ErasedStroke = Stroke & { erasedAtMs: number };

interface EraseGroup {
  strokeIds: string[];
  strokes: ErasedStroke[];
  firstErasedAt: number;
  lastErasedAt: number;
  /** union of erased strokes' bboxes, unpadded */
  rawBbox: BBox;
  /** rawBbox padded per spec, used for overlap matching against candidate after-strokes */
  paddedBbox: BBox;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function makeGroup(strokes: ErasedStroke[], cfg: PairingConfig): EraseGroup {
  const rawBbox = unionBBoxes(strokes.map((s) => s.bbox));
  const erasedTimes = strokes.map((s) => s.erasedAtMs);
  return {
    strokeIds: strokes.map((s) => s.id),
    strokes,
    firstErasedAt: Math.min(...erasedTimes),
    lastErasedAt: Math.max(...erasedTimes),
    rawBbox,
    paddedBbox: padBBox(rawBbox, cfg.padMinPx, cfg.padFrac),
  };
}

/**
 * Groups erased strokes into EraseGroups. Two erased strokes join the same
 * group when they are both close in time (<= eraseGroupGapMs) AND spatially
 * adjacent/overlapping (padded-by-padMinPx bbox intersection). Requiring both
 * conditions is what keeps two simultaneous-but-separate erasures (rule 5) in
 * distinct groups while still coalescing a single multi-stroke eraser drag
 * (rule 1).
 */
function buildEraseGroups(strokes: Stroke[], cfg: PairingConfig): EraseGroup[] {
  // A scribble stroke is the erasing gesture (like the eraser's path), not erased content: the
  // strokes it covered are the "before"; the zig-zag itself is never part of a revision.
  const erased = strokes
    .filter(
      (s): s is ErasedStroke =>
        s.erased && !s.isScribble && !!s.erasedBy && s.erasedBy !== 'undo' && s.erasedAtMs != null,
    )
    .sort((a, b) => a.erasedAtMs - b.erasedAtMs);

  const n = erased.length;
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const timeOk = Math.abs(erased[i].erasedAtMs - erased[j].erasedAtMs) <= cfg.eraseGroupGapMs;
      if (!timeOk) continue;
      const spaceOk = boxesIntersect(
        padBBox(erased[i].bbox, cfg.padMinPx, 0),
        padBBox(erased[j].bbox, cfg.padMinPx, 0),
      );
      if (spaceOk) uf.union(i, j);
    }
  }

  const clusters = new Map<number, ErasedStroke[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const list = clusters.get(root);
    if (list) list.push(erased[i]);
    else clusters.set(root, [erased[i]]);
  }

  return Array.from(clusters.values())
    .map((list) => makeGroup(list, cfg))
    .sort((a, b) => a.firstErasedAt - b.firstErasedAt);
}

// ---------------------------------------------------------------------------
// after-stroke collection
// ---------------------------------------------------------------------------

function collectAfterStrokes(
  group: EraseGroup,
  candidatesSortedByStart: Stroke[],
  allGroups: EraseGroup[],
  cfg: PairingConfig,
): Stroke[] {
  const after: Stroke[] = [];
  const hardCap = group.lastErasedAt + cfg.maxWindowMs;
  let windowEnd = Math.min(hardCap, group.lastErasedAt + cfg.correctionWindowMs);
  let lastTime = group.lastErasedAt;

  for (const s of candidatesSortedByStart) {
    if (s.startMs < group.lastErasedAt) continue;
    if (s.startMs > windowEnd) break;

    // Stop early if a spatially-separate erase group starts inside the gap
    // we're currently considering -- that erasure "claims" the timeline from
    // here on for its own region.
    const blocked = allGroups.some(
      (g) =>
        g !== group &&
        g.firstErasedAt > lastTime &&
        g.firstErasedAt <= s.startMs &&
        overlapRatio(g.rawBbox, group.paddedBbox) < cfg.minOverlap,
    );
    if (blocked) break;

    const ov = overlapRatio(s.bbox, group.paddedBbox);
    if (ov >= cfg.minOverlap) {
      after.push(s);
      lastTime = s.startMs;
      windowEnd = Math.min(hardCap, Math.max(windowEnd, s.startMs + cfg.continueGapMs));
    }
  }

  return after;
}

// ---------------------------------------------------------------------------
// kind classification
// ---------------------------------------------------------------------------

function classifyKind(erasedStrokes: ErasedStroke[], afterStrokes: Stroke[], cfg: PairingConfig): RevisionKind {
  const allYoungWhenErased = erasedStrokes.every((s) => s.erasedAtMs - s.startMs < cfg.microAgeMs);
  const totalErasedInk = erasedStrokes.reduce((sum, s) => sum + s.inkLen, 0);
  if (allYoungWhenErased || totalErasedInk < cfg.minErasedInkPx) return 'micro';
  if (afterStrokes.length > 0) return 'correction';
  return 'deletion';
}

// ---------------------------------------------------------------------------
// chaining + finalization
// ---------------------------------------------------------------------------

interface GroupInfo {
  group: EraseGroup;
  after: Stroke[];
}

function finalizeChain(chain: GroupInfo[], sessionId: string, cfg: PairingConfig, index: number): Revision {
  const first = chain[0];
  const last = chain[chain.length - 1];
  const allErasedStrokes = chain.flatMap((gi) => gi.group.strokes);

  const beforeStrokeIds = first.group.strokeIds;
  const afterStrokeIds = last.after.map((s) => s.id);
  const lectureMs = first.group.firstErasedAt;
  const bbox = unionBBoxes([first.group.rawBbox, ...last.after.map((s) => s.bbox)]);
  const kind = classifyKind(allErasedStrokes, last.after, cfg);

  return {
    id: `${sessionId}:rev:${lectureMs}:${index}`,
    sessionId,
    lectureMs,
    beforeStrokeIds,
    afterStrokeIds,
    bbox,
    kind,
  };
}

export function pairRevisions(input: {
  sessionId: string;
  strokes: Stroke[];
  eraseEvents: EraseEvent[];
  config?: Partial<PairingConfig>;
}): Revision[] {
  const cfg: PairingConfig = { ...PAIRING_CONFIG, ...input.config };
  const { sessionId } = input;
  // Work on the page as it is: a stroke cut by a partial erase is represented by its pieces
  // (erased pieces are the "before", live ink written afterwards is the "after").
  const strokes = activeStrokes(input.strokes);

  const groups = buildEraseGroups(strokes, cfg);
  const candidates = strokes.filter((s) => !s.erased && !s.isScribble).sort((a, b) => a.startMs - b.startMs);

  const groupInfos: GroupInfo[] = groups.map((group) => ({
    group,
    after: collectAfterStrokes(group, candidates, groups, cfg),
  }));

  const chains: GroupInfo[][] = [];
  let current: GroupInfo[] = [];

  for (const gi of groupInfos) {
    if (current.length === 0) {
      current = [gi];
      continue;
    }
    const prev = current[current.length - 1];
    const prevActiveBbox =
      prev.after.length > 0 ? unionBBoxes([prev.group.rawBbox, ...prev.after.map((s) => s.bbox)]) : prev.group.rawBbox;
    const prevActivityEnd =
      prev.after.length > 0
        ? Math.max(prev.group.lastErasedAt, ...prev.after.map((s) => s.endMs))
        : prev.group.lastErasedAt;

    const timeOk = gi.group.firstErasedAt - prevActivityEnd <= cfg.chainWindowMs;
    const spaceOk = overlapRatio(gi.group.rawBbox, prevActiveBbox) >= cfg.minOverlap;

    if (timeOk && spaceOk) {
      current.push(gi);
    } else {
      chains.push(current);
      current = [gi];
    }
  }
  if (current.length) chains.push(current);

  return chains.map((chain, i) => finalizeChain(chain, sessionId, cfg, i));
}
