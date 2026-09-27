// Geometry for the "Try it" canvas: a small, client-side version of the app's erase → correction
// pairing (lib/pairing.ts in the app). Erased strokes are grouped; a new stroke drawn soon after,
// over the (padded) erased area, is paired with it as a correction. Pure, so it's unit tested.

export type BBox = [minX: number, minY: number, maxX: number, maxY: number];
export interface Pt {
  x: number;
  y: number;
}

export const TRYIT_CONFIG = {
  /** Erases this close together in time form one group. */
  eraseGroupGapMs: 3000,
  /** A rewrite must start within this long after the erase. */
  correctionWindowMs: 20_000,
  padMinPx: 16,
  padFrac: 0.15,
  /** Share of the new stroke's box that must fall inside the padded erased area. */
  minOverlap: 0.3,
  /** Eraser radius, CSS px. */
  eraserRadius: 14,
} as const;

export type TryitConfig = { [K in keyof typeof TRYIT_CONFIG]: number };

export function bboxOf(points: readonly Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return [minX, minY, maxX, maxY];
}

export function unionBBox(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function padBBox(b: BBox, cfg: Pick<TryitConfig, "padMinPx" | "padFrac"> = TRYIT_CONFIG): BBox {
  const diag = Math.hypot(b[2] - b[0], b[3] - b[1]);
  const pad = Math.max(cfg.padMinPx, cfg.padFrac * diag);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

const area = (b: BBox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** Share of `inner`'s area that lies inside `outer` (0..1). Thin strokes get a 2 px minimum size. */
export function overlapShare(inner: BBox, outer: BBox): number {
  const cx = (inner[0] + inner[2]) / 2;
  const cy = (inner[1] + inner[3]) / 2;
  const w = Math.max(2, inner[2] - inner[0]);
  const h = Math.max(2, inner[3] - inner[1]);
  const b: BBox = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  const ix: BBox = [Math.max(b[0], outer[0]), Math.max(b[1], outer[1]), Math.min(b[2], outer[2]), Math.min(b[3], outer[3])];
  return area(ix) / area(b);
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Does an eraser at `p` (radius r) touch this polyline? */
export function hitsStroke(points: readonly Pt[], p: Pt, r: number): boolean {
  if (points.length === 1) return Math.hypot(points[0].x - p.x, points[0].y - p.y) <= r;
  for (let i = 1; i < points.length; i++) if (distToSegment(p, points[i - 1], points[i]) <= r) return true;
  return false;
}

export interface EraseGroup {
  id: number;
  bbox: BBox;
  /** Time of the latest erase in the group (ms). */
  at: number;
  /** Set once a rewrite has been paired with it. */
  correctedBy?: number;
}

/** Add an erased stroke's box at time `t`: joins the last group when close in time, else starts one. */
export function addErase(groups: readonly EraseGroup[], bbox: BBox, t: number, nextId: number, cfg: TryitConfig = TRYIT_CONFIG): EraseGroup[] {
  const last = groups[groups.length - 1];
  if (last && !last.correctedBy && t - last.at <= cfg.eraseGroupGapMs) {
    return [...groups.slice(0, -1), { ...last, bbox: unionBBox(last.bbox, bbox), at: t }];
  }
  return [...groups, { id: nextId, bbox, at: t }];
}

/** The erase group a new stroke (box, drawn at `t`) corrects, if any: newest eligible first. */
export function findCorrection(groups: readonly EraseGroup[], strokeBox: BBox, t: number, cfg: TryitConfig = TRYIT_CONFIG): EraseGroup | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.correctedBy !== undefined) continue;
    if (t < g.at || t - g.at > cfg.correctionWindowMs) continue;
    if (overlapShare(strokeBox, padBBox(g.bbox, cfg)) >= cfg.minOverlap) return g;
  }
  return null;
}

/* ───────── partial eraser (a small version of the app's splitStrokeByEraser in lib/ink.ts) ───────── */

export interface Run {
  erased: boolean;
  points: Pt[];
}

/** Polyline length in px. */
export function inkLength(points: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return n;
}

/** Live pieces shorter than this are dropped (crumbs left at the eraser's edge). */
export const MIN_KEPT_INK_PX = 3;

/**
 * Cut a stroke where an eraser (a circle of `radius` swept along `eraserPath`, so a fast drag
 * between two samples still counts) passes over it. Returns null when the eraser doesn't touch
 * it; otherwise the stroke as contiguous runs — outside the eraser (live) and inside (erased) —
 * with boundary points placed where it crosses the eraser's edge. When nothing meaningful stays
 * live, it's a single erased run with the whole stroke.
 */
export function splitByEraser(points: readonly Pt[], eraserPath: readonly Pt[], radius: number): Run[] | null {
  if (!points.length || !eraserPath.length) return null;
  const segs: [Pt, Pt][] = [];
  if (eraserPath.length === 1) segs.push([eraserPath[0], eraserPath[0]]);
  for (let i = 1; i < eraserPath.length; i++) segs.push([eraserPath[i - 1], eraserPath[i]]);
  const inside = (p: Pt) => segs.some(([a, b]) => distToSegment(p, a, b) <= radius);
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  const step = Math.max(0.5, radius / 4);
  const runs: Run[] = [];
  let cur: Run = { erased: inside(points[0]), points: [points[0]] };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    let prevT = 0;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const now = inside(lerp(a, b, t));
      if (now !== cur.erased) {
        // Bisect the crossing for a clean boundary point shared by both runs.
        let lo = prevT;
        let hi = t;
        for (let it = 0; it < 12; it++) {
          const mid = (lo + hi) / 2;
          if (inside(lerp(a, b, mid)) === cur.erased) lo = mid;
          else hi = mid;
        }
        const edge = lerp(a, b, (lo + hi) / 2);
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
  const kept = runs.filter((r) => r.erased || inkLength(r.points) >= MIN_KEPT_INK_PX);
  if (!kept.some((r) => !r.erased)) return [{ erased: true, points: [...points] }];
  return kept;
}
