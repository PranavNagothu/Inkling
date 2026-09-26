// Minimal runtime validation for API payloads.
import type { EraseEvent, Stroke } from "./types";

const POINTER_KINDS = new Set(["pen", "mouse", "touch"]);
const ERASED_BY = new Set<string>(["eraser", "scribble", "strike", "undo"] satisfies EraseEvent["by"][]);

/** Most points one stroke may hold; longer pen-downs are split into consecutive strokes client-side. */
export const MAX_STROKE_POINTS = 20000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

export function isStroke(v: unknown): v is Stroke {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (!isStr(s.id) || !isNum(s.startMs) || !isNum(s.endMs)) return false;
  if (!Array.isArray(s.points) || s.points.length === 0 || s.points.length > MAX_STROKE_POINTS) return false;
  for (const p of s.points) {
    if (!Array.isArray(p) || p.length !== 4 || !p.every(isNum)) return false;
  }
  if (typeof s.pointerType !== "string" || !POINTER_KINDS.has(s.pointerType)) return false;
  if (!Array.isArray(s.bbox) || s.bbox.length !== 4 || !s.bbox.every(isNum)) return false;
  if (!isNum(s.inkLen) || !isNum(s.medianSpeed)) return false;
  if (typeof s.erased !== "boolean" || typeof s.isScribble !== "boolean") return false;
  if (s.erasedAtMs !== null && !isNum(s.erasedAtMs)) return false;
  if (s.erasedBy !== null && (typeof s.erasedBy !== "string" || !ERASED_BY.has(s.erasedBy))) return false;
  // Optional partial-erase lineage.
  if (s.splitFrom != null && !isStr(s.splitFrom)) return false;
  if (s.replacedBy != null) {
    if (!Array.isArray(s.replacedBy) || s.replacedBy.length > 1000 || !s.replacedBy.every(isStr)) return false;
  }
  return true;
}

export function isEraseEvent(v: unknown): v is EraseEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (!isStr(e.id) || !isNum(e.atMs)) return false;
  if (!Array.isArray(e.strokeIds) || !e.strokeIds.every(isStr)) return false;
  if (typeof e.by !== "string" || !ERASED_BY.has(e.by)) return false;
  return true;
}
