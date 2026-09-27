"use client";

// "Try it": a tiny Inkling canvas. Write with a mouse, finger or Pencil (Pointer Events) in a
// choice of pen size and colour, then erase — a real, partial eraser like the app's: only the ink
// under the eraser goes, strokes split into pieces, and the erased parts stay as dashed teal ghost
// ink. Rewrite in the same spot and the pair is flagged as a correction (lib/tryit.ts), the same
// erase → rewrite idea the app uses, minus the lecture clock. Everything runs locally.
//
// Keyboard/screen-reader path: every control is a button or radio group, "Show me" plays the whole
// sequence, and a polite live region narrates what happened.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  TRYIT_CONFIG,
  addErase,
  bboxOf,
  findCorrection,
  overlapShare,
  padBBox,
  splitByEraser,
  unionBBox,
  type BBox,
  type EraseGroup,
  type Pt,
} from "@/lib/landing/tryit";
import { motionTokens, springs } from "@/lib/motion";
import { layoutLine } from "./strokeFont";
import { CheckIcon, EraserIcon, EyeIcon, PenIcon, PlayIcon, ResetIcon } from "./icons";
import { RadioGroup } from "./RadioGroup";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";
import { LiquidMetal } from "./ui/liquid-metal";

type Tool = "pen" | "eraser";

const SIZES = { fine: 1.5, medium: 3, bold: 5 } as const;
type Size = keyof typeof SIZES;
const COLORS = { ink: "#0f172a", blue: "#2563eb", teal: "#0d9488", red: "#dc2626" } as const;
type Color = keyof typeof COLORS;
const ERASERS = { small: 10, large: 22 } as const;
type EraserSize = keyof typeof ERASERS;

interface InkStroke {
  id: number;
  points: Pt[];
  width: number;
  color: string;
  bbox: BBox;
  erased: boolean;
}

interface Correction {
  id: number;
  groupId: number;
  bbox: BBox;
  at: number;
}

const GHOST = "rgba(13, 148, 136, 0.62)";
const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly Pt[]) {
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

export function TryIt() {
  const reduce = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const measureRef = useRef<SVGSVGElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  const strokes = useRef<InkStroke[]>([]);
  const groups = useRef<EraseGroup[]>([]);
  const active = useRef<{ id: number; mode: Tool; pointerId: number; last: Pt; hit: boolean } | null>(null);
  const nextId = useRef(1);
  const frame = useRef(0);
  const ghostRef = useRef(true);
  const demoToken = useRef(0);

  const [tool, setTool] = useState<Tool>("pen");
  const [size, setSize] = useState<Size>("medium");
  const [color, setColor] = useState<Color>("ink");
  const [eraser, setEraser] = useState<EraserSize>("small");
  const [ghost, setGhost] = useState(true);
  const [counts, setCounts] = useState({ written: 0, erased: 0, corrected: 0 });
  const [pieces, setPieces] = useState({ live: 0, ghost: 0 });
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [status, setStatus] = useState("");
  const [demo, setDemo] = useState(false);
  const [hasInk, setHasInk] = useState(false);

  const radius = ERASERS[eraser];
  const radiusRef = useRef(radius);
  useEffect(() => {
    radiusRef.current = radius;
  }, [radius]);

  /* ───────── drawing ───────── */

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.current) {
      if (s.erased) {
        if (!ghostRef.current) continue;
        ctx.strokeStyle = GHOST;
        ctx.fillStyle = GHOST;
        ctx.lineWidth = Math.max(1.6, Math.min(3, s.width * 0.8));
        ctx.setLineDash([5, 6]);
      } else {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.setLineDash([]);
      }
      tracePath(ctx, s.points);
      if (s.points.length === 1) ctx.fill();
      else ctx.stroke();
    }
    ctx.setLineDash([]);
  }, []);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const syncPieces = useCallback(() => {
    let live = 0;
    let ghostN = 0;
    for (const s of strokes.current) {
      if (s.erased) ghostN += 1;
      else live += 1;
    }
    setPieces({ live, ghost: ghostN });
  }, []);

  // Size the canvas to its box (device pixels), redraw on resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(wrap.clientWidth * dpr);
      canvas.height = Math.round(wrap.clientHeight * dpr);
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [draw]);

  useEffect(() => {
    ghostRef.current = ghost;
    schedule();
  }, [ghost, schedule]);

  // Stop a running demo on unmount.
  useEffect(() => () => void (demoToken.current += 1), []);

  /* ───────── ink operations (shared by pointer input and the demo) ───────── */

  const begin = useCallback(
    (p: Pt, pressure: number, width: number, inkColor: string): number => {
      const id = nextId.current++;
      const w = width * (0.8 + Math.min(1, Math.max(0.1, pressure || 0.5)) * 0.4);
      strokes.current = [...strokes.current, { id, points: [p], width: w, color: inkColor, bbox: [p.x, p.y, p.x, p.y], erased: false }];
      setHasInk(true);
      schedule();
      return id;
    },
    [schedule],
  );

  const extend = useCallback(
    (id: number, pts: Pt[]) => {
      strokes.current = strokes.current.map((s) => {
        if (s.id !== id) return s;
        const points = [...s.points];
        for (const p of pts) {
          const last = points[points.length - 1];
          if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.8) points.push(p);
        }
        return { ...s, points };
      });
      schedule();
    },
    [schedule],
  );

  const end = useCallback(
    (id: number) => {
      const s0 = strokes.current.find((x) => x.id === id);
      if (!s0) return;
      const s = { ...s0, bbox: bboxOf(s0.points) };
      strokes.current = strokes.current.map((x) => (x.id === id ? s : x));
      const t = now();
      setCounts((c) => ({ ...c, written: c.written + 1 }));
      syncPieces();

      const group = findCorrection(groups.current, s.bbox, t);
      if (group) {
        groups.current = groups.current.map((g) => (g.id === group.id ? { ...g, correctedBy: s.id } : g));
        setCorrections((cs) => [...cs, { id: s.id, groupId: group.id, bbox: unionBBox(group.bbox, s.bbox), at: t }]);
        setCounts((c) => ({ ...c, corrected: c.corrected + 1 }));
        setStatus("Correction detected: your rewrite was paired with the ink you erased.");
        return;
      }
      // More strokes of the same rewrite grow the highlighted box.
      setCorrections((cs) =>
        cs.map((c) =>
          t - c.at <= TRYIT_CONFIG.correctionWindowMs && overlapShare(s.bbox, padBBox(c.bbox)) >= TRYIT_CONFIG.minOverlap
            ? { ...c, bbox: unionBBox(c.bbox, s.bbox), at: t }
            : c,
        ),
      );
    },
    [syncPieces],
  );

  /** Erase along a path (the eraser moved from path[0] to path[1]). Returns true if any ink was cut. */
  const eraseAlong = useCallback(
    (path: Pt[], r: number): boolean => {
      const t = now();
      let cut = false;
      const next: InkStroke[] = [];
      for (const s of strokes.current) {
        if (s.erased || s.id === active.current?.id || s.points.length === 0) {
          next.push(s);
          continue;
        }
        const runs = splitByEraser(s.points, path, r);
        if (!runs) {
          next.push(s);
          continue;
        }
        cut = true;
        for (const run of runs) {
          const piece: InkStroke = { ...s, id: nextId.current++, points: run.points, bbox: bboxOf(run.points), erased: run.erased };
          next.push(piece);
          if (run.erased) groups.current = addErase(groups.current, piece.bbox, t, piece.id);
        }
      }
      if (cut) {
        strokes.current = next;
        schedule();
        syncPieces();
      }
      return cut;
    },
    [schedule, syncPieces],
  );

  const noteErased = useCallback(() => {
    setCounts((c) => ({ ...c, erased: c.erased + 1 }));
    setStatus(
      ghostRef.current
        ? "Erased. The ink under the eraser is kept as ghost ink. Now rewrite it in the same spot."
        : "Erased. Ghost ink is hidden, but Inkling still remembers it.",
    );
  }, []);

  const moveCursor = (p: Pt | null, r: number = radiusRef.current) => {
    const el = cursorRef.current;
    if (!el) return;
    if (!p) {
      el.style.opacity = "0";
      return;
    }
    el.style.opacity = "1";
    el.style.width = el.style.height = `${r * 2}px`;
    el.style.transform = `translate3d(${p.x - r}px, ${p.y - r}px, 0)`;
  };

  /* ───────── pointer input ───────── */

  const toLocal = (e: { clientX: number; clientY: number }): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (demo || active.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // A Pencil/stylus eraser end or eraser button erases regardless of the selected tool.
    const penEraser = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);
    const mode: Tool = tool === "eraser" || penEraser ? "eraser" : "pen";
    const p = toLocal(e);
    if (mode === "eraser") {
      const hit = eraseAlong([p], radius);
      active.current = { id: -1, mode, pointerId: e.pointerId, last: p, hit };
      if (hit) noteErased();
      moveCursor(p);
    } else {
      active.current = { id: begin(p, e.pressure, SIZES[size], COLORS[color]), mode, pointerId: e.pointerId, last: p, hit: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = active.current;
    const native = e.nativeEvent;
    const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [native];
    if (!a) {
      if (tool === "eraser" && e.pointerType !== "touch") moveCursor(toLocal(e));
      return;
    }
    if (a.pointerId !== e.pointerId) return;
    if (a.mode === "eraser") {
      const path = [a.last, ...events.map(toLocal)];
      a.last = path[path.length - 1];
      if (eraseAlong(path, radius) && !a.hit) {
        a.hit = true;
        noteErased();
      }
      moveCursor(a.last);
    } else {
      extend(a.id, events.map(toLocal));
    }
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = active.current;
    if (!a || a.pointerId !== e.pointerId) return;
    active.current = null;
    if (a.mode === "pen") end(a.id);
    if (e.pointerType === "touch") moveCursor(null);
  };

  /* ───────── controls ───────── */

  const reset = useCallback(() => {
    demoToken.current += 1;
    strokes.current = [];
    groups.current = [];
    active.current = null;
    setCounts({ written: 0, erased: 0, corrected: 0 });
    setPieces({ live: 0, ghost: 0 });
    setCorrections([]);
    setHasInk(false);
    setDemo(false);
    setStatus("Canvas cleared.");
    moveCursor(null);
    schedule();
  }, [schedule]);

  /** Sample the stroke-font paths for a line of text into canvas points. */
  const sampleLine = (text: string, x: number, baseline: number, scale: number): Pt[][] => {
    const svg = measureRef.current;
    if (!svg) return [];
    const line = layoutLine(text, x, baseline, scale);
    return line.strokes.map(({ d }) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
      const len = path.getTotalLength();
      const pts: Pt[] = [];
      const steps = Math.max(2, Math.ceil(len / 2.5));
      for (let i = 0; i <= steps; i++) {
        const q = path.getPointAtLength((len * i) / steps);
        pts.push({ x: q.x, y: q.y });
      }
      svg.removeChild(path);
      return pts;
    });
  };

  const playDemo = async () => {
    const wrap = wrapRef.current;
    if (!wrap || demo) return;
    reset();
    const token = demoToken.current;
    const alive = () => demoToken.current === token;
    setDemo(true);
    setStatus("Playing an example: a derivative written, erased and rewritten.");

    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const lhsText = "d/dx x² = ";
    const probe = layoutLine(lhsText + "x²", 0, 0, 1);
    const scale = Math.min((W * 0.72) / probe.width, (H * 0.3) / 48);
    const x0 = (W - probe.width * scale) / 2;
    const baseline = H * 0.56;
    const lhsW = layoutLine(lhsText, 0, 0, scale).width;
    const lhs = sampleLine(lhsText, x0, baseline, scale);
    const attempt = sampleLine("x²", x0 + lhsW, baseline, scale);
    const rewrite = sampleLine("2x", x0 + lhsW, baseline, scale);

    const write = async (paths: Pt[][]) => {
      for (const pts of paths) {
        if (!alive()) return;
        const id = begin(pts[0], 0.5, SIZES.medium, COLORS.ink);
        if (reduce) {
          extend(id, pts.slice(1));
        } else {
          for (let i = 1; i < pts.length; i += 3) {
            if (!alive()) return;
            extend(id, pts.slice(i, i + 3));
            await sleep(12);
          }
        }
        end(id);
        if (!reduce) await sleep(70);
      }
    };

    await write(lhs);
    if (!alive()) return;
    await write(attempt);
    if (!alive()) return;
    await sleep(reduce ? 0 : 500);

    // Erase the attempt, as one gesture: the eraser traces the attempt's own strokes with a tight
    // radius, so nothing else on the line (like the "=") is touched however small the canvas is.
    let hit = false;
    for (const pts of attempt) {
      for (let i = 1; i < pts.length; i += 3) {
        if (!alive()) return;
        if (eraseAlong(pts.slice(i - 1, i + 3), 3) && !hit) {
          hit = true;
          noteErased();
        }
        if (!reduce) {
          moveCursor(pts[i], 12);
          await sleep(14);
        }
      }
    }
    moveCursor(null);
    if (!alive()) return;
    await sleep(reduce ? 0 : 600);
    await write(rewrite);
    if (alive()) setDemo(false);
  };

  const selectTool = (t: Tool) => {
    setTool(t);
    if (t === "pen") moveCursor(null);
  };

  const summary = `${counts.written} stroke${counts.written === 1 ? "" : "s"} written, ${counts.erased} erase${counts.erased === 1 ? "" : "s"}, ${counts.corrected} correction${counts.corrected === 1 ? "" : "s"} detected.`;
  const detected = counts.corrected > 0;

  const chip = (checked: boolean) =>
    checked ? "bg-white shadow-sm ring-1 ring-teal-600/40" : "hover:bg-white/70";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] lg:gap-10">
      {/* Steps + live counts */}
      <div className="flex flex-col gap-6 lg:pt-2">
        <ol className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
          {[
            { n: "1", title: "Write something", body: "A number, a word, an equation. Pick a pen size and colour." },
            { n: "2", title: "Erase part of it", body: "Only the ink under the eraser goes, and it stays behind as dashed ghost ink." },
            { n: "3", title: "Rewrite in the same spot", body: "Inkling pairs the rewrite with what you erased." },
          ].map((s) => (
            <li key={s.n} className="card flex gap-4 p-4">
              <span
                aria-hidden="true"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-teal-600/20 bg-accent-soft font-mono text-[13px] font-medium text-accent-strong"
              >
                {s.n}
              </span>
              <div>
                <h3 className="text-[15px] font-semibold text-ink">{s.title}</h3>
                <p className="mt-1 text-[14px] leading-relaxed text-pretty text-ink-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <dl className="grid grid-cols-3 gap-3" aria-label="What Inkling saw">
          {[
            { label: "Written", value: counts.written },
            { label: "Erased", value: counts.erased },
            { label: "Corrections", value: counts.corrected },
          ].map((m) => (
            <div key={m.label} className="card rounded-xl px-4 py-3">
              <dt className="text-[12px] tracking-wide text-ink-subtle uppercase">{m.label}</dt>
              <dd className="mt-1 font-mono text-2xl text-ink tabular-nums">{m.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* The canvas card */}
      <div className="card overflow-hidden rounded-[1.4rem] p-1.5 shadow-page sm:p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-2 sm:px-3">
          <div role="group" aria-label="Tool" className="flex rounded-full border border-line bg-chrome-hover p-1">
            {(
              [
                { t: "pen", label: "Pen", Icon: PenIcon },
                { t: "eraser", label: "Eraser", Icon: EraserIcon },
              ] as const
            ).map(({ t, label, Icon }) => (
              <button
                key={t}
                type="button"
                aria-pressed={tool === t}
                onClick={() => selectTool(t)}
                disabled={demo}
                className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-[background-color,color] duration-200 disabled:opacity-50 ${
                  tool === t ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:bg-white hover:text-ink"
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-0.5 sm:gap-1.5">
            <button
              type="button"
              role="switch"
              aria-checked={ghost}
              onClick={() => setGhost((g) => !g)}
              className="inline-flex min-h-11 items-center gap-2.5 rounded-full px-3 text-[14px] text-ink-muted transition-colors hover:bg-chrome-hover hover:text-ink"
            >
              <span
                aria-hidden="true"
                className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors duration-200 ${
                  ghost ? "border-teal-600 bg-teal-600" : "border-line-strong bg-slate-200"
                }`}
              >
                <span
                  className={`absolute size-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
                    ghost ? "translate-x-[1.2rem]" : "translate-x-[0.2rem]"
                  }`}
                />
              </span>
              <EyeIcon size={16} className="hidden sm:block" />
              Ghost ink
            </button>
            <button
              type="button"
              onClick={playDemo}
              disabled={demo}
              className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-[14px] font-medium text-accent-strong transition-colors hover:bg-accent-soft disabled:opacity-50"
            >
              <PlayIcon size={13} />
              Show me
            </button>
            <button
              type="button"
              onClick={reset}
              className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-[14px] text-ink-muted transition-colors hover:bg-chrome-hover hover:text-ink"
            >
              <ResetIcon size={16} />
              <span className="max-sm:sr-only">Reset</span>
            </button>
          </div>
        </div>

        {/* Tool options: pen size + colour, or eraser size */}
        <div className="flex min-h-14 flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-2 py-1.5 sm:px-3">
          {tool === "pen" ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium tracking-wide text-ink-subtle uppercase" aria-hidden="true">
                  Size
                </span>
                <RadioGroup<Size>
                  label="Pen size"
                  value={size}
                  onChange={setSize}
                  disabled={demo}
                  optionClassName={chip}
                  options={(Object.keys(SIZES) as Size[]).map((k) => ({
                    value: k,
                    label: k === "fine" ? "Fine" : k === "medium" ? "Medium" : "Bold",
                    children: (
                      <span
                        aria-hidden="true"
                        className="rounded-full"
                        style={{ width: SIZES[k] * 2 + 2, height: SIZES[k] * 2 + 2, background: COLORS[color] }}
                      />
                    ),
                  }))}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium tracking-wide text-ink-subtle uppercase" aria-hidden="true">
                  Colour
                </span>
                <RadioGroup<Color>
                  label="Ink colour"
                  value={color}
                  onChange={setColor}
                  disabled={demo}
                  optionClassName={chip}
                  options={(Object.keys(COLORS) as Color[]).map((k) => ({
                    value: k,
                    label: k === "ink" ? "Ink" : k === "blue" ? "Blue" : k === "teal" ? "Teal" : "Red",
                    children: (
                      <span
                        aria-hidden="true"
                        className="size-5 rounded-full ring-2 ring-white shadow-[0_0_0_1px_rgb(15_23_42/0.2)]"
                        style={{ background: COLORS[k] }}
                      />
                    ),
                  }))}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium tracking-wide text-ink-subtle uppercase" aria-hidden="true">
                Eraser
              </span>
              <RadioGroup<EraserSize>
                label="Eraser size"
                value={eraser}
                onChange={setEraser}
                disabled={demo}
                optionClassName={(c) => `${chip(c)} gap-2 px-3 text-[14px] text-ink`}
                options={(Object.keys(ERASERS) as EraserSize[]).map((k) => ({
                  value: k,
                  label: k === "small" ? "Small" : "Large",
                  children: (
                    <>
                      <span
                        aria-hidden="true"
                        className="rounded-full border-2 border-slate-500"
                        style={{ width: k === "small" ? 12 : 20, height: k === "small" ? 12 : 20 }}
                      />
                      {k === "small" ? "Small" : "Large"}
                    </>
                  ),
                }))}
              />
            </div>
          )}
        </div>

        <div
          ref={wrapRef}
          className="tryit-paper relative aspect-[4/3] w-full overflow-hidden rounded-[1rem] border border-line sm:aspect-[16/10]"
        >
          <canvas
            ref={canvasRef}
            data-testid="tryit-canvas"
            data-live={pieces.live}
            data-ghost={pieces.ghost}
            role="img"
            aria-label={`Drawing area. ${summary}`}
            className={`absolute inset-0 h-full w-full touch-none select-none ${tool === "eraser" ? "cursor-none" : "cursor-crosshair"}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
            onPointerCancel={finish}
            onPointerLeave={(e) => {
              if (!active.current) moveCursor(null);
              if (e.pointerType === "mouse" && active.current?.pointerId === e.pointerId && !e.buttons) finish(e);
            }}
          />

          {/* Eraser cursor */}
          <div
            ref={cursorRef}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 rounded-full border-2 border-slate-500 bg-slate-900/[0.04] opacity-0 shadow-[0_0_0_1px_rgba(255,255,255,.9)] transition-opacity duration-150"
          />

          {/* Correction outlines */}
          <AnimatePresence>
            {corrections.map((c) => {
              const [x0, y0, x1, y1] = padBBox(c.bbox, { padMinPx: 10, padFrac: 0.06 });
              return (
                <motion.div
                  key={c.id}
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-xl border-[1.5px] border-dashed border-cyan-600/80 bg-cyan-500/[0.06]"
                  style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0, transformOrigin: "center" }}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.08 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? { duration: 0 } : springs.snappy}
                >
                  <span className="absolute -top-3 left-3 rounded-full bg-cyan-700 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-white uppercase">
                    Corrected
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* Empty-state hint */}
          <AnimatePresence>
            {!hasInk && (
              <motion.div
                key="hint"
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: motionTokens.duration.fast } }}
              >
                <span className="inline-flex size-12 items-center justify-center rounded-full border border-line bg-white text-ink-muted shadow-sm">
                  <PenIcon size={20} />
                </span>
                <p className="font-display text-2xl text-ink-muted italic sm:text-3xl">Write anything here</p>
                <p className="text-[13px] text-ink-subtle">or press “Show me”</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* The chip */}
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
            <AnimatePresence>
              {detected && (
                <motion.p
                  key={`chip-${counts.corrected}`}
                  data-testid="correction-chip"
                  className="relative isolate inline-flex items-center gap-2 overflow-hidden rounded-full py-1.5 pr-4 pl-1.5 text-[13px] font-semibold text-teal-950 shadow-[0_12px_28px_-12px_rgb(8_145_178/0.6)] ring-1 ring-teal-700/25"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: -motionTokens.distance.md, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: motionTokens.duration.fast } }}
                  transition={reduce ? { duration: 0 } : springs.bouncy}
                >
                  <LiquidMetal as="span" css variant="teal" aria-hidden="true" className="absolute inset-0 -z-10" />
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-teal-700 text-white">
                    <CheckIcon size={14} strokeWidth={2.4} />
                  </span>
                  Correction detected
                  <span className="hidden font-medium text-teal-900/80 sm:inline">· erase → rewrite paired</span>
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Off-screen measuring SVG for the demo's stroke-font paths */}
          <svg ref={measureRef} aria-hidden="true" className="pointer-events-none absolute h-0 w-0 overflow-hidden" />
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-3 text-[13px] text-ink-subtle">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-5 rounded-full bg-ink" />
            Ink
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-0 w-5 border-t-2 border-dashed border-teal-500" />
            Ghost ink (erased)
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-3 rounded-[4px] border border-dashed border-cyan-600" />
            Correction
          </span>
          <span className="ml-auto hidden sm:inline">Runs in your browser. Nothing is uploaded.</span>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}
