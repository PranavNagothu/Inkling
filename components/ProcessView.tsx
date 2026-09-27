"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Revision, Stroke, TimelineEvent } from "@/lib/types";
import { fitContain, inkFrame, momentAnchors, spreadMarkers, toScreenRect } from "@/lib/compare";
import { activeStrokes } from "@/lib/ink";
import { MOMENT_META } from "@/lib/moments";
import { drawHighlight, paintStrokes } from "@/lib/render";
import { MomentGlyph, momentAriaLabel } from "./Timeline";

/** Ruled-line spacing and first-rule offset of the capture page (see .paper in globals.css). */
const RULE_GAP = 32;
const RULE_OFFSET = RULE_GAP * 1.5;
/** Never blow a sparse page up past this. */
const MAX_SCALE = 1.25;
/** Marker hit area (px) — also the minimum distance between markers. */
const MARKER_HIT = 44;

interface ProcessViewProps {
  sessionId: string;
  strokes: Stroke[];
  events: TimelineEvent[];
  revisions: Revision[];
  /**
   * Overlay mode: only the left fraction (0–1) of the view is visible. Markers beyond it are taken
   * out of the tab order and the accessibility tree.
   */
  visibleUntil?: number;
  className?: string;
}

/**
 * "Inkling — the process": the session's page scaled to fit, with ghost ink always on and every
 * learning moment pinned where it happened on the page. A marker opens that moment in the review.
 */
export default function ProcessView({ sessionId, strokes, events, revisions, visibleUntil = 1, className = "" }: ProcessViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.round(r.width), h: Math.round(r.height), dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frame = useMemo(() => inkFrame(strokes), [strokes]);
  const fit = useMemo(
    () => fitContain({ width: frame[2] - frame[0], height: frame[3] - frame[1] }, { width: box.w, height: box.h }, MAX_SCALE),
    [frame, box.w, box.h],
  );
  const anchors = useMemo(() => momentAnchors(events, revisions, strokes), [events, revisions, strokes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (fit.scale === 0) return;
    const s = box.dpr * fit.scale;
    ctx.setTransform(s, 0, 0, s, box.dpr * (fit.x - frame[0] * fit.scale), box.dpr * (fit.y - frame[1] * fit.scale));
    // Soft outlines under the ink show where each moment happened.
    for (const { event, bbox } of anchors) drawHighlight(ctx, bbox, MOMENT_META[event.type].color, 8);
    paintStrokes(ctx, strokes, true);
  }, [strokes, anchors, fit, frame, box.dpr]);

  const markers = useMemo(() => {
    const pinned = anchors.map(({ event, bbox }) => {
      const r = toScreenRect(bbox, frame, fit);
      const half = MARKER_HIT / 2;
      return {
        event,
        // Top-right corner of the moment's area, kept inside the view.
        x: Math.min(Math.max(r.left + r.width, half), Math.max(half, box.w - half)),
        y: Math.min(Math.max(r.top, half), Math.max(half, box.h - half)),
      };
    });
    return spreadMarkers(pinned, MARKER_HIT - 8);
  }, [anchors, frame, fit, box.w, box.h]);

  const erased = activeStrokes(strokes).filter((s) => s.erased).length;
  const scale = fit.scale || 1;

  return (
    <div
      ref={wrapRef}
      data-testid="inkling-process"
      data-ghost="on"
      data-erased-count={erased}
      data-marker-count={markers.length}
      className={`paper relative size-full overflow-hidden ${className}`}
      style={
        {
          "--rule-gap": `${RULE_GAP * scale}px`,
          backgroundPosition: `0 ${fit.y + (RULE_OFFSET - frame[1]) * scale}px`,
        } as React.CSSProperties
      }
    >
      <canvas
        ref={canvasRef}
        data-testid="process-canvas"
        data-ghost="on"
        role="img"
        aria-label={`Your notes with ${erased} erased ${erased === 1 ? "piece" : "pieces"} shown as ghost ink`}
        width={Math.max(1, Math.round(box.w * box.dpr))}
        height={Math.max(1, Math.round(box.h * box.dpr))}
        style={{ width: box.w || "100%", height: box.h || "100%" }}
        className="absolute top-0 left-0 block"
      />
      {box.w > 0 && markers.length > 0 ? (
        <ol aria-label="Moments on the page" className="absolute inset-0">
          {markers.map(({ event, x, y }) => {
            const hidden = x > box.w * visibleUntil;
            return (
              <li key={event.id} className="absolute" style={{ left: x, top: y }} aria-hidden={hidden || undefined}>
                <Link
                  href={`/review/${encodeURIComponent(sessionId)}?moment=${encodeURIComponent(event.id)}`}
                  data-testid="process-marker"
                  data-event-id={event.id}
                  data-type={event.type}
                  aria-label={`${momentAriaLabel(event)} — open in review`}
                  title={`${MOMENT_META[event.type].label} — open in review`}
                  tabIndex={hidden ? -1 : undefined}
                  className="group absolute inline-flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill"
                >
                  <span className="inline-flex size-6 items-center justify-center rounded-pill bg-chrome shadow-[0_0_0_1px_rgb(15_23_42/0.12),0_2px_6px_-1px_rgb(15_23_42/0.25)] transition-transform duration-150 ease-out group-hover:scale-110 group-active:scale-95">
                    <MomentGlyph type={event.type} size={16} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
