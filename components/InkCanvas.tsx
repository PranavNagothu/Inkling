"use client";

import { useEffect, useRef, useState } from "react";
import type { BBox, PointerKind, Point, Stroke, Tool } from "@/lib/types";
import { splitLongStroke } from "@/lib/autosave";
import { activeStrokes, inkCounts, newId, splitStrokeByEraser, type SplitResult, type XY } from "@/lib/ink";
import { MAX_STROKE_POINTS } from "@/lib/validate";
import { INK_COLOR, drawHighlight, drawStroke, drawStrokePath, renderRegion, renderStrokes } from "@/lib/render";

export const ERASER_RADIUS = 12;

interface InkCanvasProps {
  strokes: Stroke[];
  showGhost: boolean;
  tool?: Tool;
  readOnly?: boolean;
  /** Current lecture clock in ms (audio.currentTime * 1000). */
  getLectureMs?: () => number;
  onStrokeEnd?: (points: Point[], pointerType: PointerKind) => void;
  /**
   * Called once per eraser gesture that touched ink. `changed` holds every stroke to upsert: cut
   * parents (with replacedBy), their new pieces, and strokes erased in place. `erasedIds` are the
   * strokes that became ghost ink (erased pieces, or whole strokes the eraser fully covered).
   */
  onErase?: (result: { changed: Stroke[]; erasedIds: string[] }, atMs: number) => void;
  testId?: string;
  className?: string;
  /** Read-only overlay: a dashed outline around a region of the page (e.g. the selected moment). */
  highlight?: { bbox: BBox; color: string } | null;
}

interface ActiveGesture {
  pointerId: number;
  pointerType: PointerKind;
  tool: Tool;
  startLectureMs: number;
  startTimeStamp: number;
  points: Point[];
  erase: EraseState | null;
}

/** Eraser drag state. Each touched stroke is re-cut from its pre-gesture form using the whole path. */
interface EraseState {
  path: XY[];
  /** Live strokes at gesture start (the only ones the eraser can cut). */
  candidates: Stroke[];
  results: Map<string, SplitResult>;
  touchedAtMs: Map<string, number>;
}

/** Strokes as they should look mid-gesture: touched strokes swapped for their cut result. */
function applyResults(strokes: Stroke[], results: Map<string, SplitResult>): Stroke[] {
  if (results.size === 0) return strokes;
  return strokes.flatMap((s) => {
    const r = results.get(s.id);
    return r ? [r.parent, ...r.pieces.filter((p) => p.id !== r.parent.id)] : [s];
  });
}

const toKind = (t: string): PointerKind => (t === "pen" || t === "touch" ? t : "mouse");

/** Ink → ghost fade after a scribble-out (skipped under prefers-reduced-motion). */
const SCRIBBLE_FADE_MS = 450;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function InkCanvas({
  strokes,
  showGhost,
  tool = "pen",
  readOnly = false,
  getLectureMs,
  onStrokeEnd,
  onErase,
  testId = "ink-canvas",
  className = "",
  highlight = null,
}: InkCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const penSeenRef = useRef(false);
  const prevStrokesRef = useRef(strokes);
  const fadeRef = useRef<{ strokes: Stroke[]; start: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  // Track the element size so the backing store matches devicePixelRatio.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height), dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Full redraw whenever strokes / ghost mode / size change.
  useEffect(() => {
    // A scribble-out just landed: its zig-zag and the ink it covered fade from ink to their stored
    // (ghost) look instead of vanishing in one frame.
    const prev = prevStrokesRef.current;
    if (prev !== strokes) {
      prevStrokesRef.current = strokes;
      const was = new Map(prev.map((s) => [s.id, s]));
      const newly = strokes.filter(
        (s) => s.erased && (s.erasedBy === "scribble" || s.erasedBy === "strike") && !was.get(s.id)?.erased,
      );
      if (newly.length && !prefersReducedMotion()) fadeRef.current = { strokes: newly, start: performance.now() };
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || size.w === 0) return;
    let raf = 0;
    const paint = () => {
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      const g = gestureRef.current;
      renderStrokes(ctx, size.w, size.h, g?.erase ? applyResults(strokes, g.erase.results) : strokes, showGhost);
      const fade = fadeRef.current;
      if (fade) {
        const t = (performance.now() - fade.start) / SCRIBBLE_FADE_MS;
        if (t >= 1) {
          fadeRef.current = null;
        } else {
          const alpha = (1 - t) ** 2; // ease-out
          for (const s of fade.strokes) drawStroke(ctx, s, false, alpha);
          raf = requestAnimationFrame(paint);
        }
      }
      if (g && g.tool === "pen") {
        ctx.save();
        ctx.lineCap = "round";
        ctx.strokeStyle = INK_COLOR;
        ctx.fillStyle = INK_COLOR;
        drawStrokePath(ctx, g.points, g.pointerType);
        ctx.restore();
      }
      if (highlight) drawHighlight(ctx, highlight.bbox, highlight.color);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [strokes, showGhost, size, highlight]);

  const pointFrom = (ev: PointerEvent, g: ActiveGesture): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = Math.round((ev.clientX - rect.left) * 10) / 10;
    const y = Math.round((ev.clientY - rect.top) * 10) / 10;
    // Lecture time at pen-down plus elapsed wall time keeps per-point timing even when audio is paused.
    const t = Math.round(g.startLectureMs + Math.max(0, ev.timeStamp - g.startTimeStamp));
    const pressure = Math.round((ev.pressure || 0) * 1000) / 1000;
    return [x, y, pressure, t];
  };

  /** Extends the eraser path to (x, y), re-cuts every stroke the new segment reaches and repaints that area. */
  const eraseTo = (g: ActiveGesture, x: number, y: number) => {
    const st = g.erase;
    if (!st) return;
    const prev = st.path[st.path.length - 1] ?? [x, y];
    st.path.push([x, y]);
    const r = ERASER_RADIUS;
    const seg: BBox = [Math.min(prev[0], x) - r, Math.min(prev[1], y) - r, Math.max(prev[0], x) + r, Math.max(prev[1], y) + r];
    let dirty: BBox | null = null;
    for (const s of st.candidates) {
      const [x0, y0, x1, y1] = s.bbox;
      if (x1 < seg[0] || x0 > seg[2] || y1 < seg[1] || y0 > seg[3]) continue;
      const atMs = st.touchedAtMs.get(s.id) ?? getLectureMs?.() ?? 0;
      const res = splitStrokeByEraser(s, st.path, r, atMs, () => newId("k_"));
      if (!res) continue;
      st.touchedAtMs.set(s.id, atMs);
      st.results.set(s.id, res);
      dirty = dirty
        ? [Math.min(dirty[0], x0), Math.min(dirty[1], y0), Math.max(dirty[2], x1), Math.max(dirty[3], y1)]
        : [x0, y0, x1, y1];
    }
    const ctx = canvasRef.current?.getContext("2d");
    if (dirty && ctx) renderRegion(ctx, dirty, applyResults(strokes, st.results), showGhost);
  };

  const drawLiveSegment = (g: ActiveGesture, from: number) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = INK_COLOR;
    ctx.fillStyle = INK_COLOR;
    drawStrokePath(ctx, g.points.slice(Math.max(0, from - 1)), g.pointerType);
    ctx.restore();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || gestureRef.current) return;
    const kind = toKind(e.pointerType);
    if (kind === "pen") penSeenRef.current = true;
    // Palm rejection: once a pen has been used, ignore touch input.
    if (kind === "touch" && penSeenRef.current) return;
    if (e.button !== 0 && kind === "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const g: ActiveGesture = {
      pointerId: e.pointerId,
      pointerType: kind,
      tool,
      startLectureMs: getLectureMs?.() ?? 0,
      startTimeStamp: e.nativeEvent.timeStamp,
      points: [],
      erase:
        tool === "eraser"
          ? {
              path: [],
              candidates: activeStrokes(strokes).filter((s) => !s.erased),
              results: new Map(),
              touchedAtMs: new Map(),
            }
          : null,
    };
    gestureRef.current = g;
    const p = pointFrom(e.nativeEvent, g);
    if (tool === "pen") {
      g.points.push(p);
      drawLiveSegment(g, 0);
    } else {
      eraseTo(g, p[0], p[1]);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    e.preventDefault();
    const native = e.nativeEvent;
    const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [native];
    if (g.tool === "pen") {
      const from = g.points.length;
      for (const ev of events) g.points.push(pointFrom(ev, g));
      drawLiveSegment(g, from);
      if (g.points.length > MAX_STROKE_POINTS) {
        // A very long pen-down: hand over what is drawn as finished strokes and carry on in a new
        // one from the same point, so no stroke exceeds what the server stores per stroke.
        const pieces = splitLongStroke(g.points, MAX_STROKE_POINTS);
        g.points = pieces.pop()!;
        for (const piece of pieces) onStrokeEnd?.(piece, g.pointerType);
      }
    } else {
      for (const ev of events) {
        const p = pointFrom(ev, g);
        eraseTo(g, p[0], p[1]);
      }
    }
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    gestureRef.current = null;
    if (g.tool === "pen") {
      if (g.points.length > 0) onStrokeEnd?.(g.points, g.pointerType);
    } else if (g.erase && g.erase.results.size > 0) {
      const changed: Stroke[] = [];
      const erasedIds: string[] = [];
      for (const { parent, pieces } of g.erase.results.values()) {
        changed.push(parent, ...pieces.filter((p) => p.id !== parent.id));
        erasedIds.push(...pieces.filter((p) => p.erased).map((p) => p.id));
      }
      onErase?.({ changed, erasedIds }, getLectureMs?.() ?? 0);
    }
  };

  // Piece counts (data-stroke/visible/erased-count) describe the page as stored: cut strokes are
  // represented by their pieces, and a scribble-out's zig-zag (stored erased, lib/scribble) counts
  // as ghost ink. The people-facing counts (data-drawn-count / data-erased-part-count, the
  // "1 stroke · 1 erased part" label) count lines the student drew instead (inkCounts, lib/ink).
  const active = activeStrokes(strokes);
  const visible = active.filter((s) => !s.erased).length;
  const counts = inkCounts(strokes);

  return (
    <div ref={wrapRef} className={`relative w-full overflow-hidden ${className}`}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Note canvas"
        data-testid={testId}
        data-stroke-count={active.length}
        data-visible-count={visible}
        data-erased-count={active.length - visible}
        data-drawn-count={counts.drawn}
        data-erased-part-count={counts.erasedParts}
        data-ghost={showGhost ? "on" : "off"}
        data-tool={tool}
        data-highlight={highlight ? "on" : "off"}
        width={Math.max(1, Math.round(size.w * size.dpr))}
        height={Math.max(1, Math.round(size.h * size.dpr))}
        style={{
          width: size.w || "100%",
          height: size.h || "100%",
          // Drawing needs every pointer move (no browser panning); a read-only page (review) must
          // still scroll and pinch-zoom under a finger on an iPad.
          touchAction: readOnly ? "manipulation" : "none",
        }}
        className={`absolute top-0 left-0 block select-none ${readOnly ? "" : tool === "eraser" ? "cursor-cell" : "cursor-crosshair"}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
