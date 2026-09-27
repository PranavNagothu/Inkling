// Before/after crops of a revision: painted on screen by MomentDetail and exported as small PNGs
// for revision reading (POST /api/events/[id]/read-revision). Client only.
import { drawStroke } from "@/lib/render";
import type { BBox, Stroke } from "@/lib/types";

export const CROP_PAD = 14;
const MAX_ZOOM = 2;
const PAPER = "#fffffd"; // --color-paper
/** Stay under the server's 200 KB per image, with room to spare. */
const MAX_PNG_CHARS = Math.floor((180 * 1024 * 4) / 3);

/**
 * Paints `focus` strokes (ghost ink for "before", ink for "after") cropped to `bbox` into a w×h
 * CSS-px area, over the surrounding live ink at low opacity. Scales to fit, never past MAX_ZOOM.
 */
export function paintCrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scaleToDevice: number,
  crop: { focus: Stroke[]; context: Stroke[]; bbox: BBox; ghost: boolean },
) {
  const { focus, context, bbox, ghost } = crop;
  const [x0, y0, x1, y1] = [bbox[0] - CROP_PAD, bbox[1] - CROP_PAD, bbox[2] + CROP_PAD, bbox[3] + CROP_PAD];
  const scale = Math.min(w / (x1 - x0), h / (y1 - y0), MAX_ZOOM);
  const ox = (w - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = (h - (y1 - y0) * scale) / 2 - y0 * scale;
  ctx.setTransform(scaleToDevice * scale, 0, 0, scaleToDevice * scale, scaleToDevice * ox, scaleToDevice * oy);
  for (const s of context) drawStroke(ctx, s, false, 0.18);
  for (const s of focus) drawStroke(ctx, s, ghost, ghost ? 0.9 : 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The crop as a PNG data URL on paper-coloured background (shrinks until it fits the size cap). */
export function cropToPng(crop: { focus: Stroke[]; context: Stroke[]; bbox: BBox; ghost: boolean }): string | null {
  for (const [w, h] of [
    [480, 320],
    [360, 240],
    [240, 160],
  ]) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);
    paintCrop(ctx, w, h, 1, crop);
    const url = canvas.toDataURL("image/png");
    if (url.startsWith("data:image/png;base64,") && url.length <= MAX_PNG_CHARS) return url;
  }
  return null;
}
