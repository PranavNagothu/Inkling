// Scribble-out: a pen zig-zag over existing ink erases it, exactly like the eraser. Nothing is
// hard-deleted — the covered strokes AND the zig-zag itself are kept as ghost ink.
//
// Stored shape of a scribble-out (whole-stroke, never split):
//   scribble stroke: isScribble = true, erased = true, erasedBy = 'scribble', erasedAtMs = its endMs
//   covered strokes: erased = true, erasedBy = 'scribble', erasedAtMs = the scribble's endMs
//   one EraseEvent { by: 'scribble', strokeIds: covered ids, atMs: the scribble's endMs }
// Because the zig-zag is stored erased, every activeStrokes()-based counter, the renderer, the
// eraser and the pairing "after" candidates treat it as ghost ink with no special casing.
//
// Undoing a scribble-out keeps the zig-zag (erasedBy 'undo', like any undone stroke) and restores
// the covered strokes to live ink (erased false, erasedAtMs/erasedBy null) — persisted by upsert.
import type { EraseEvent, Stroke } from "./types";
import { activeStrokes } from "./ink";
import { detectScribble } from "./pairing";

/** A pen gesture that erased ink: a scribble-out zig-zag, or a confirmed strike-through (./strike). */
export interface ScribbleOut {
  /** The gesture stroke (zig-zag or line). */
  scribbleId: string;
  coveredIds: string[];
  atMs: number;
  /** Absent = 'scribble'. */
  by?: "scribble" | "strike";
}

export interface ScribbleTransition {
  /** The whole stroke list after the change. */
  strokes: Stroke[];
  /** Ids of strokes that changed (to upsert). */
  changedIds: string[];
  event: EraseEvent;
}

/**
 * Adds `stroke` (a just-finished pen stroke, not yet in `strokes`) to the page. When it scribbles
 * out earlier live ink, returns the scribble-out transition; otherwise null (caller adds it as ink).
 */
export function applyScribbleOut(
  strokes: Stroke[],
  stroke: Stroke,
  eventId: string,
): (ScribbleTransition & { scribble: ScribbleOut }) | null {
  const live = activeStrokes(strokes).filter((s) => !s.erased && s.id !== stroke.id);
  const coveredIds = detectScribble(stroke, live);
  if (coveredIds.length === 0) return null;
  const atMs = stroke.endMs;
  const covered = new Set(coveredIds);
  const next = strokes.map((s) =>
    covered.has(s.id) ? { ...s, erased: true, erasedAtMs: atMs, erasedBy: "scribble" as const } : s,
  );
  next.push({ ...stroke, isScribble: true, erased: true, erasedAtMs: atMs, erasedBy: "scribble" });
  return {
    strokes: next,
    changedIds: [...coveredIds, stroke.id],
    event: { id: eventId, sessionId: stroke.sessionId, atMs, strokeIds: coveredIds, by: "scribble" },
    scribble: { scribbleId: stroke.id, coveredIds, atMs, by: "scribble" },
  };
}

/**
 * Reverses a scribble-out: the zig-zag becomes an undone stroke (erasedBy 'undo', kept as ghost)
 * and the strokes it covered become live ink again. Returns null when it was already undone.
 */
export function undoScribbleOut(
  strokes: Stroke[],
  scribble: Pick<ScribbleOut, "scribbleId" | "coveredIds">,
  atMs: number,
  eventId: string,
): ScribbleTransition | null {
  const zig = strokes.find((s) => s.id === scribble.scribbleId);
  // Works for both pen gestures: the covered strokes carry the gesture's erasedBy.
  const by = zig?.erasedBy;
  if (!zig || (by !== "scribble" && by !== "strike")) return null;
  const covered = new Set(scribble.coveredIds);
  const changedIds = [zig.id];
  const next = strokes.map((s) => {
    if (s.id === zig.id) return { ...s, erased: true, erasedAtMs: atMs, erasedBy: "undo" as const };
    if (covered.has(s.id) && s.erased && s.erasedBy === by) {
      changedIds.push(s.id);
      return { ...s, erased: false, erasedAtMs: null, erasedBy: null };
    }
    return s;
  });
  return {
    strokes: next,
    changedIds,
    event: { id: eventId, sessionId: zig.sessionId, atMs, strokeIds: [zig.id], by: "undo" },
  };
}
