"use client";

import { useEffect, useRef, useState } from "react";
import { fitContain } from "@/lib/compare";
import { describePdfError, type PdfErrorKind } from "@/lib/notability";
// Types only: pdf.js itself is loaded on demand (see usePdfDocument).
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "@/lib/pdf";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { iconBtn } from "./ui";

export type PdfDocState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; doc: PDFDocumentProxy; numPages: number }
  | { status: "error"; kind: PdfErrorKind; message: string };

type Keyed = PdfDocState & { src: string };

/**
 * Downloads and opens a PDF with pdf.js. pdf.js itself is imported here, on demand, so only the
 * compare page (and only once there is a PDF) loads it.
 */
export function usePdfDocument(src: string | null): PdfDocState {
  const [state, setState] = useState<Keyed | null>(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    (async () => {
      const res = await fetch(src);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: "ResponseException" });
      const data = await res.arrayBuffer();
      const { openPdf } = await import("@/lib/pdf");
      if (cancelled) return;
      task = openPdf(data);
      const doc = await task.promise;
      if (cancelled) return;
      if (doc.numPages < 1) throw Object.assign(new Error("no pages"), { name: "InvalidPDFException" });
      setState({ src, status: "ready", doc, numPages: doc.numPages });
    })().catch((err: unknown) => {
      if (cancelled) return;
      console.warn("Could not open the Notability PDF:", err);
      setState({ src, status: "error", ...describePdfError(err) });
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [src]);

  if (!src) return { status: "idle" };
  if (!state || state.src !== src) return { status: "loading" };
  return state;
}

/** Keep the backing store under what iPad Safari allows for one canvas (~16.7 M pixels). */
const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * One PDF page, scaled to fit its box ("contain") and drawn at device resolution. Re-renders on
 * resize; `data-rendered` turns true once the current page is on screen.
 */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function PdfPage({
  doc,
  pageNumber,
  className = "",
  onPageRect,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  className?: string;
  /** Where the drawn page sits inside this component's box (px), once drawn. */
  onPageRect?: (rect: PageRect) => void;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onPageRectRef = useRef(onPageRect);
  useEffect(() => {
    onPageRectRef.current = onPageRect;
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, dpr: 1 });
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = `${pageNumber}:${box.w}x${box.h}@${box.dpr}`;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.floor(r.width), h: Math.floor(r.height), dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || box.w === 0 || box.h === 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const fit = fitContain(base, { width: box.w, height: box.h });
      let pixelScale = fit.scale * box.dpr;
      const pixels = base.width * base.height * pixelScale * pixelScale;
      if (pixels > MAX_CANVAS_PIXELS) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale: pixelScale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${fit.width}px`;
      canvas.style.height = `${fit.height}px`;
      canvas.style.left = `${fit.x}px`;
      canvas.style.top = `${fit.y}px`;
      task = page.render({ canvas, viewport });
      await task.promise;
      if (cancelled) return;
      setRenderedKey(key);
      const outer = outerRef.current?.getBoundingClientRect();
      const drawn = canvas.getBoundingClientRect();
      if (outer) onPageRectRef.current?.({ x: drawn.left - outer.left, y: drawn.top - outer.top, width: drawn.width, height: drawn.height });
    })().catch((err: unknown) => {
      if (cancelled || (err instanceof Error && err.name === "RenderingCancelledException")) return;
      console.warn("Could not draw the Notability PDF page:", err);
      setFailure({ key, message: describePdfError(err).message });
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, box, key]);

  const rendered = renderedKey === key;
  const failed = failure?.key === key ? failure.message : null;

  return (
    <div
      ref={outerRef}
      data-testid="notability-pdf"
      data-rendered={rendered ? "true" : "false"}
      data-page={pageNumber}
      data-page-count={doc.numPages}
      className={`relative size-full overflow-hidden ${className}`}
    >
      {/* The page is fitted inside this inset box (so it never runs into the panel's edges). */}
      <div ref={wrapRef} className="absolute inset-3 sm:inset-4">
        <canvas
          ref={canvasRef}
          data-testid="notability-pdf-canvas"
          role="img"
          aria-label={`Notability export, page ${pageNumber} of ${doc.numPages}`}
          className={`absolute block rounded-sm bg-white shadow-page outline outline-1 -outline-offset-1 outline-black/10 transition-opacity duration-200 ${
            rendered ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
      {!rendered && !failed ? (
        <p role="status" className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-ink-muted">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-pill bg-accent" />
          Drawing page {pageNumber}…
        </p>
      ) : null}
      {failed ? (
        <p role="alert" data-testid="notability-error" className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-sm text-pretty text-danger">
          {failed}
        </p>
      ) : null}
    </div>
  );
}

/** "‹ Page 1 of 3 ›" — only shown for multi-page exports. */
export function PageNav({ page, count, onChange }: { page: number; count: number; onChange: (page: number) => void }) {
  if (count < 2) return null;
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Pages">
      <button
        type="button"
        data-testid="pdf-prev"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className={`${iconBtn} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <ChevronLeftIcon size={18} />
      </button>
      <span data-testid="pdf-page-label" aria-live="polite" className="min-w-[5.5rem] text-center text-sm tabular-nums text-ink-muted">
        Page {page} of {count}
      </span>
      <button
        type="button"
        data-testid="pdf-next"
        aria-label="Next page"
        disabled={page >= count}
        onClick={() => onChange(page + 1)}
        className={`${iconBtn} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <ChevronRightIcon size={18} />
      </button>
    </div>
  );
}
