// Undo for an eraser gesture (toolbar Undo right after erasing). Pure and client-safe.
//
// Partial-erase lineage is sticky in storage (a cut stroke stays replaced by its pieces; see the
// upsert in ./db), so undo does not un-cut the parent: it brings the gesture's erased pieces (and
// any strokes it erased whole) back to live ink. The pieces are contiguous, so the line reads
// exactly as before; the original erase event is then "reversed" (every stroke it erased is live
// again — see isReversedErase in ./scoring) and no longer counts, and an 'undo' event records it.
import type { EraseEvent, Stroke } from "./types";

/** What one eraser gesture erased (the ids that became ghost ink). */
export interface EraseGesture {
  erasedIds: string[];
}

export function undoEraseGesture(
  strokes: Stroke[],
  gesture: EraseGesture,
  atMs: number,
  eventId: string,
): { strokes: Stroke[]; changedIds: string[]; event: EraseEvent } | null {
  const ids = new Set(gesture.erasedIds);
  const changedIds: string[] = [];
  let sessionId = "";
  const next = strokes.map((s) => {
    if (!ids.has(s.id) || !s.erased || s.erasedBy !== "eraser" || s.replacedBy?.length) return s;
    changedIds.push(s.id);
    sessionId = s.sessionId;
    return { ...s, erased: false, erasedAtMs: null, erasedBy: null };
  });
  if (changedIds.length === 0) return null;
  return {
    strokes: next,
    changedIds,
    event: { id: eventId, sessionId, atMs, strokeIds: changedIds, by: "undo" },
  };
}
