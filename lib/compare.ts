// Notability compare page: pure layout and summary helpers (client-safe).
import { activeStrokes } from './ink';
import { SCORING_CONFIG } from './scoring';
import type { BBox, Revision, Stroke, TimelineEvent } from './types';

/** "What the final page hides": what a final-page-only export throws away. */
export interface HiddenStats {
  /**
   * Erased ink still kept as ghost ink (pieces of partially erased strokes count individually, and
   * a scribble-out's / strike-through's own gesture stroke counts too). An ordinary Undo takes a
   * stroke back rather than erasing it (erasedBy 'undo', as in isErasedPart), so it never counts.
   */
  erased: number;
  corrections: number;
  gaps: number;
  breakthroughs: number;
}

/** Same counting as the review page's summary chips, so both pages always agree. */
export function hiddenStats(strokes: Stroke[], events: TimelineEvent[]): HiddenStats {
  const count = (type: TimelineEvent['type']) => events.filter((e) => e.type === type).length;
  return {
    erased: activeStrokes(strokes).filter((s) => s.erased && s.erasedBy !== 'undo').length,
    corrections: count('misconception_corrected'),
    gaps: count('unresolved_gap'),
    breakthroughs: count('breakthrough'),
  };
}

export interface Size {
  width: number;
  height: number;
}

/** Where content lands when scaled to fit inside a box ("object-fit: contain"), centred. */
export interface Fit {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitContain(content: Size, box: Size, maxScale = Infinity): Fit {
  if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { scale: 0, x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / content.width, box.height / content.height, maxScale);
  const width = content.width * scale;
  const height = content.height * scale;
  return { scale, x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * The part of the notebook page to show: from the page's top-left corner (where the student's
 * canvas started) to just past the furthest ink, never smaller than `min` so a sparse page keeps
 * a page-like shape.
 */
export function inkFrame(strokes: Stroke[], { pad = 32, min = [640, 480] }: { pad?: number; min?: [number, number] } = {}): BBox {
  let right = 0;
  let bottom = 0;
  for (const s of activeStrokes(strokes)) {
    right = Math.max(right, s.bbox[2]);
    bottom = Math.max(bottom, s.bbox[3]);
  }
  return [0, 0, Math.max(min[0], right > 0 ? right + pad : 0), Math.max(min[1], bottom > 0 ? bottom + pad : 0)];
}

const union = (boxes: BBox[]): BBox =>
  boxes.reduce<BBox>(
    (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

/**
 * Where each moment sits on the page: its revision's bbox; else the ink written or erased during its
 * scoring window (e.g. the words erased in a hesitation burst); else the ink closest in time.
 * Moments with nothing on the page are left out.
 */
export function momentAnchors(
  events: TimelineEvent[],
  revisions: Revision[],
  strokes: Stroke[],
  windowMs: number = SCORING_CONFIG.windowMs,
): Array<{ event: TimelineEvent; bbox: BBox }> {
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const page = activeStrokes(strokes);
  const out: Array<{ event: TimelineEvent; bbox: BBox }> = [];
  for (const event of events) {
    const rev = event.revisionId ? byId.get(event.revisionId) : undefined;
    if (rev) {
      out.push({ event, bbox: rev.bbox });
      continue;
    }
    const from = event.windowStartMs ?? Math.floor(event.lectureMs / windowMs) * windowMs;
    const to = from + windowMs;
    const inWindow = (t: number | null) => t !== null && t >= from && t < to;
    const touched = page.filter((s) => inWindow(s.startMs) || inWindow(s.erasedAtMs));
    if (touched.length > 0) {
      out.push({ event, bbox: union(touched.map((s) => s.bbox)) });
      continue;
    }
    let nearest: Stroke | null = null;
    let best = Infinity;
    for (const s of page) {
      const d = Math.min(Math.abs(s.startMs - event.lectureMs), s.erasedAtMs === null ? Infinity : Math.abs(s.erasedAtMs - event.lectureMs));
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    if (nearest) out.push({ event, bbox: nearest.bbox });
  }
  return out;
}

/** A world-space bbox mapped into the panel, given the frame shown and how it was fitted. */
export function toScreenRect(bbox: BBox, frame: BBox, fit: Fit): { left: number; top: number; width: number; height: number } {
  return {
    left: fit.x + (bbox[0] - frame[0]) * fit.scale,
    top: fit.y + (bbox[1] - frame[1]) * fit.scale,
    width: (bbox[2] - bbox[0]) * fit.scale,
    height: (bbox[3] - bbox[1]) * fit.scale,
  };
}

/** Nudges markers right until none is within `minGap` of an earlier one (so hit areas don't stack). */
export function spreadMarkers<P extends { x: number; y: number }>(points: P[], minGap: number): P[] {
  const placed: P[] = [];
  for (const p of points) {
    let x = p.x;
    for (;;) {
      const hit = placed.find((q) => Math.abs(q.x - x) < minGap && Math.abs(q.y - p.y) < minGap);
      if (!hit) break;
      x = hit.x + minGap;
    }
    placed.push({ ...p, x });
  }
  return placed;
}

// Overlay mode: the process view is revealed over the final page from the left, 0–100 %.
export const REVEAL_STEP = 5;
export const REVEAL_BIG_STEP = 25;
export const DEFAULT_REVEAL = 50;

export function clampReveal(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_REVEAL;
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

/** Reveal for a pointer at clientX over a stage spanning [left, left + width]. */
export function revealAt(clientX: number, rect: { left: number; width: number }): number {
  if (rect.width <= 0) return DEFAULT_REVEAL;
  return clampReveal(((clientX - rect.left) / rect.width) * 100);
}

/** Slider keyboard behaviour (WAI-ARIA APG); null for keys the slider doesn't handle. */
export function revealForKey(current: number, key: string, big = false): number | null {
  const step = big ? REVEAL_BIG_STEP : REVEAL_STEP;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clampReveal(current + step);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampReveal(current - step);
    case 'PageUp':
      return clampReveal(current + REVEAL_BIG_STEP);
    case 'PageDown':
      return clampReveal(current - REVEAL_BIG_STEP);
    case 'Home':
      return 0;
    case 'End':
      return 100;
    default:
      return null;
  }
}
