// Canvas 2D rendering of strokes, shared by capture and review views.
import type { BBox, Point, Stroke } from "./types";

export const INK_COLOR = "#0f172a"; // --color-ink
export const GHOST_COLOR = "#0d9488"; // --color-ghost (teal, drawn dashed at 50%)
export const BASE_WIDTH = 2.4;

function widthFor(p: Point, pointerType: Stroke["pointerType"]): number {
  // Only pens report meaningful pressure.
  if (pointerType !== "pen") return BASE_WIDTH;
  const pressure = p[2] > 0 ? p[2] : 0.5;
  return BASE_WIDTH * (0.5 + pressure);
}

export function drawStrokePath(ctx: CanvasRenderingContext2D, points: Point[], pointerType: Stroke["pointerType"]) {
  if (points.length === 0) return;
  if (points.length === 1) {
    const [x, y] = points[0];
    ctx.beginPath();
    ctx.arc(x, y, widthFor(points[0], pointerType) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < points.length; i++) {
    ctx.lineWidth = widthFor(points[i], pointerType);
    ctx.beginPath();
    ctx.moveTo(points[i - 1][0], points[i - 1][1]);
    ctx.lineTo(points[i][0], points[i][1]);
    ctx.stroke();
  }
}

/** Draws one stroke as ink or ghost ink. `alpha` overrides the default opacity (ink 1, ghost 0.5). */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, ghost: boolean, alpha?: number) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (alpha !== undefined) ctx.globalAlpha = alpha;
  if (ghost) {
    ctx.globalAlpha = alpha ?? 0.5; // teal is lighter than ink: half strength keeps it legible yet clearly "erased"
    ctx.strokeStyle = GHOST_COLOR;
    ctx.fillStyle = GHOST_COLOR;
    ctx.setLineDash([6, 5]);
    // Draw as one path so the dash pattern flows along the stroke.
    ctx.lineWidth = BASE_WIDTH;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  } else {
    ctx.strokeStyle = INK_COLOR;
    ctx.fillStyle = INK_COLOR;
    drawStrokePath(ctx, s.points, s.pointerType);
  }
  ctx.restore();
}

/** A scribble-out's zig-zag is ghost ink too, but drawn fainter so the mistake it covered reads through. */
export const SCRIBBLE_GHOST_ALPHA = 0.22;

/** Ghost pass: scribble zig-zags first (faint), then the erased ink on top. */
function drawGhosts(ctx: CanvasRenderingContext2D, ghosts: Stroke[]) {
  for (const s of ghosts) if (s.isScribble) drawStroke(ctx, s, true, SCRIBBLE_GHOST_ALPHA);
  for (const s of ghosts) if (!s.isScribble) drawStroke(ctx, s, true);
}

/** Replaced strokes (cut into pieces by a partial erase) are history only: their pieces are drawn instead. */
const isReplaced = (s: Stroke) => !!s.replacedBy?.length;

/**
 * Clears (in CSS px) and redraws the active strokes; erased ones appear (as ghost ink) only when
 * showGhost is on. Strokes that were cut into pieces are never drawn — their pieces are.
 */
export function renderStrokes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strokes: Stroke[],
  showGhost: boolean,
) {
  ctx.clearRect(0, 0, width, height);
  paintStrokes(ctx, strokes, showGhost);
}

/** renderStrokes without the clear: draws in the context's current transform (e.g. a scaled page). */
export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], showGhost: boolean) {
  if (showGhost) drawGhosts(ctx, strokes.filter((s) => s.erased && !isReplaced(s)));
  for (const s of strokes) if (!s.erased && !isReplaced(s)) drawStroke(ctx, s, false);
}

/** Like renderStrokes, but only repaints the given rectangle (CSS px) — cheap enough per pointermove. */
export function renderRegion(ctx: CanvasRenderingContext2D, region: BBox, strokes: Stroke[], showGhost: boolean) {
  const pad = BASE_WIDTH * 2;
  const [x0, y0, x1, y1] = [region[0] - pad, region[1] - pad, region[2] + pad, region[3] + pad];
  const hits = (s: Stroke) =>
    !isReplaced(s) && s.bbox[0] <= x1 + pad && s.bbox[2] >= x0 - pad && s.bbox[1] <= y1 + pad && s.bbox[3] >= y0 - pad; // bbox is centreline; pad covers line width
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  if (showGhost) drawGhosts(ctx, strokes.filter((s) => s.erased && hits(s)));
  for (const s of strokes) if (!s.erased && hits(s)) drawStroke(ctx, s, false);
  ctx.restore();
}

/** Dashed rounded outline around a region (CSS px), used to point at a moment on the page. */
export function drawHighlight(ctx: CanvasRenderingContext2D, bbox: BBox, color: string, pad = 10) {
  const [x0, y0, x1, y1] = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 8);
  ctx.globalAlpha = 0.08;
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.restore();
}
