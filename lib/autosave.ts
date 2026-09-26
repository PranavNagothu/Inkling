// Pure helpers for saving ink to POST /api/sessions/[id]/strokes. Client-safe (no server imports).
//
// Limits are shared with the route so the client never builds a request the server must refuse:
// a stroke holds at most MAX_STROKE_POINTS points (lib/validate), a request at most MAX_BATCH_ITEMS
// strokes and MAX_BATCH_ITEMS erase events, and requests aim for MAX_BATCH_BYTES (a single stroke
// bigger than that goes alone) — well under the route's MAX_STROKES_BODY_BYTES.
import type { EraseEvent, Point, Stroke } from "./types";

/** Most strokes (and, separately, erase events) the strokes route accepts in one request. */
export const MAX_BATCH_ITEMS = 5000;
/** Target size of one autosave request. */
export const MAX_BATCH_BYTES = 1_000_000;
/** Hard cap on a strokes request body (413 above it). A maximal stroke is ~0.6 MB of JSON. */
export const MAX_STROKES_BODY_BYTES = 4 * 1024 * 1024;
/**
 * Browsers cap the bodies of all in-flight keepalive requests (fetch keepalive and sendBeacon)
 * at 64 KiB per page; stay under it with room for another small request.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/**
 * Cuts a stroke's points into consecutive pieces of at most `maxPoints` each. Pieces share their
 * joining point so the ink stays continuous. A stroke within the limit comes back as one piece.
 */
export function splitLongStroke(points: Point[], maxPoints: number): Point[][] {
  if (maxPoints < 2) throw new Error("maxPoints must be at least 2");
  if (points.length <= maxPoints) return [points];
  const pieces: Point[][] = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(points.length, start + maxPoints);
    pieces.push(points.slice(start, end));
    if (end === points.length) break;
    start = end - 1; // the next piece starts on the last point of this one
  }
  return pieces;
}

export interface SaveChunk {
  strokes: Stroke[];
  eraseEvents: EraseEvent[];
  /** The request body (JSON) and its size in bytes. */
  body: string;
  bytes: number;
}

const EMPTY_BODY_BYTES = byteLength(JSON.stringify({ strokes: [], eraseEvents: [] }));

/**
 * Packs strokes then erase events, in order, into as few requests as the limits allow. Never more
 * than `maxItems` strokes or events per request; a request only exceeds `maxBytes` when a single
 * item on its own does.
 */
export function chunkBatch(
  strokes: Stroke[],
  eraseEvents: EraseEvent[],
  { maxItems = MAX_BATCH_ITEMS, maxBytes = MAX_BATCH_BYTES }: { maxItems?: number; maxBytes?: number } = {},
): SaveChunk[] {
  const chunks: SaveChunk[] = [];
  let cur = { strokes: [] as Stroke[], eraseEvents: [] as EraseEvent[], bytes: EMPTY_BODY_BYTES };
  const close = () => {
    if (cur.strokes.length === 0 && cur.eraseEvents.length === 0) return;
    const body = JSON.stringify({ strokes: cur.strokes, eraseEvents: cur.eraseEvents });
    chunks.push({ strokes: cur.strokes, eraseEvents: cur.eraseEvents, body, bytes: byteLength(body) });
    cur = { strokes: [], eraseEvents: [], bytes: EMPTY_BODY_BYTES };
  };
  const add = <K extends "strokes" | "eraseEvents">(key: K, item: SaveChunk[K][number]) => {
    const size = byteLength(JSON.stringify(item)) + 1; // + separating comma
    const list = cur[key] as unknown[];
    const empty = cur.strokes.length === 0 && cur.eraseEvents.length === 0;
    if (!empty && (list.length >= maxItems || cur.bytes + size > maxBytes)) close();
    (cur[key] as unknown[]).push(item);
    cur.bytes += size;
  };
  for (const s of strokes) add("strokes", s);
  for (const e of eraseEvents) add("eraseEvents", e);
  close();
  return chunks;
}

/**
 * How to react to a failed save. Network errors, server errors, timeouts and rate limits are
 * worth retrying unchanged; any other client error means the server will refuse this exact
 * payload again, so retrying it forever would only hide the loss.
 */
export function classifySaveFailure(status: number | "network"): "transient" | "permanent" {
  if (status === "network") return "transient";
  if (status >= 500 || status === 408 || status === 429) return "transient";
  return "permanent";
}

/** Delay before retry number `attempt` (0-based): 1 s, 2 s, 4 s, … capped at 30 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}
