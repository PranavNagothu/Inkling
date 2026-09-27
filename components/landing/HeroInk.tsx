"use client";

// Hero visual: a paper card where `d/dx sin(x²) = cos(x²)` is handwritten stroke by stroke, the
// answer is erased — and kept as dashed teal ghost ink — then `= 2x cos(x²)` is written and
// Inkling flags the moment: "Corrected · forgot the inner derivative".
//
// The server-rendered HTML is the final frame (readable without JS, and what reduced-motion users
// get). With motion allowed, the card replays the story in a gentle loop while it's on screen,
// and a Pause control stops it (WCAG 2.2.2).

import { useEffect, useState } from "react";
import { useAnimate, useInView } from "motion/react";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";
import { layoutLine } from "./strokeFont";
import { PauseIcon, PlayIcon } from "./icons";

const VIEW_W = 640;
const VIEW_H = 240;
const SIZE = 1.25;
const X0 = 40;
const BASE_1 = 116;
const BASE_2 = 196;
const RULE_GAP = 40;

const LHS_TEXT = "d/dx sin(x²) = ";
const lhs = layoutLine(LHS_TEXT, X0, BASE_1, SIZE);
const attempt = layoutLine("cos(x²)", X0 + lhs.width, BASE_1, SIZE);
const eqX = lhs.glyphX[LHS_TEXT.indexOf("=")];
const rewrite = layoutLine("= 2x cos(x²)", eqX, BASE_2, SIZE);

// Ruled lines that the handwriting sits on.
const rules = Array.from({ length: 6 }, (_, i) => BASE_1 + (i - 2) * RULE_GAP).filter((y) => y > 0 && y < VIEW_H);

const ARIA =
  "Handwritten notes: d/dx sin(x²) = cos(x²). The answer is erased but kept as dashed teal ghost ink, then rewritten below as 2x cos(x²). Inkling flags the moment as corrected: forgot the inner derivative.";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function HeroInk() {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = usePrefersReducedMotion();
  const inView = useInView(scope, { amount: 0.2 });
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const q = <T extends Element = SVGPathElement>(sel: string) => Array.from(root.querySelectorAll<T>(sel));

    /** Everything back to the final frame, instantly. */
    const showFinal = () => {
      for (const p of q("[data-draw]")) {
        p.style.opacity = "";
        p.style.strokeDashoffset = "0";
      }
      for (const el of q<HTMLElement>("[data-attempt-ink]")) el.style.opacity = "0";
      for (const el of q<HTMLElement>("[data-ghost], [data-pop]")) {
        el.style.opacity = "1";
        el.style.transform = "none";
      }
      for (const el of q<HTMLElement>("[data-progress]")) el.style.transform = "scaleX(0.58)";
    };

    if (reduce || paused || !inView) {
      showFinal();
      return;
    }

    let cancelled = false;
    const alive = () => !cancelled;
    // Every animation started by this run, so cleanup can stop them before restoring the final frame.
    const active = new Set<{ stop: () => void }>();
    const track = <A extends { stop: () => void; then: (f: () => void) => unknown }>(a: A): A => {
      active.add(a);
      a.then(() => active.delete(a));
      return a;
    };

    const drawStrokes = async (sel: string) => {
      const paths = q(sel);
      let prevGlyph = -1;
      for (const p of paths) {
        if (!alive()) return;
        const glyph = Number(p.dataset.glyph);
        const char = p.dataset.char ?? "";
        // A little lift between glyphs, a longer one at word gaps (the pen moving on).
        if (prevGlyph !== -1 && glyph !== prevGlyph) await wait(glyph - prevGlyph > 1 ? 110 : 25);
        prevGlyph = glyph;
        const len = p.getTotalLength();
        const duration = Math.min(0.26, Math.max(0.07, len / 480)) * (char === "²" ? 0.8 : 1);
        p.style.opacity = "1";
        await track(animate(p, { strokeDashoffset: [1, 0] }, { duration, ease: [0.45, 0.05, 0.4, 1] }));
      }
    };

    const loop = async () => {
      // First pass: let the finished page sit for a moment before replaying it.
      await wait(1400);
      while (alive()) {
        // Clear the page.
        await track(animate(q("[data-draw], [data-ghost], [data-pop]"), { opacity: 0 }, { duration: 0.45 }));
        if (!alive()) return;
        for (const p of q("[data-draw]")) p.style.strokeDashoffset = "1";
        for (const el of q<HTMLElement>("[data-attempt-ink]")) el.style.opacity = "1";
        track(animate(q("[data-progress]"), { scaleX: 0 }, { duration: 0.3 }));
        await wait(350);

        // The lecture plays; the playhead creeps along the mini timeline while the student writes.
        track(animate(q("[data-progress]"), { scaleX: [0, 0.58] }, { duration: 6, ease: "linear" }));

        await drawStrokes("[data-part='lhs'] [data-draw]");
        await wait(160);
        await drawStrokes("[data-part='attempt'] [data-draw]");
        if (!alive()) return;
        // Hesitation… then the erase. The ink fades; the ghost of it stays.
        await wait(900);
        track(animate(q("[data-attempt-ink]"), { opacity: 0 }, { duration: 0.4 }));
        await track(animate(q("[data-ghost]"), { opacity: [0, 1] }, { duration: 0.6, ease: "easeOut" }));
        await wait(500);

        await drawStrokes("[data-part='rewrite'] [data-draw]");
        if (!alive()) return;
        await wait(250);
        await track(animate(
          q("[data-pop]"),
          { opacity: [0, 1], transform: ["translateY(6px) scale(0.94)", "translateY(0px) scale(1)"] },
          { type: "spring", stiffness: 420, damping: 26 },
        ));
        await wait(3600);
      }
    };
    loop();

    return () => {
      cancelled = true;
      for (const a of active) a.stop();
      showFinal();
    };
  }, [animate, scope, reduce, paused, inView]);

  return (
    <figure
      ref={scope}
      className="relative mx-auto w-full max-w-[760px] overflow-hidden rounded-2xl border border-line bg-chrome text-left shadow-page"
    >
      {/* Card chrome: which lecture, which moment. */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 sm:px-4">
        <p className="min-w-0 truncate text-[13px] text-ink-muted">
          <span className="font-medium text-ink">Calculus I</span>
          <span aria-hidden="true"> · </span>The chain rule
          <span className="ml-2 font-mono text-[12px] text-ink-subtle">00:18</span>
        </p>
        {!reduce && (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Play the handwriting animation" : "Pause the handwriting animation"}
            className="-mr-1.5 inline-flex size-11 shrink-0 items-center justify-center text-ink-subtle transition-colors hover:bg-chrome-hover hover:text-ink sm:-mr-2"
          >
            {paused ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
          </button>
        )}
      </div>

      {/* The page. */}
      <div className="paper relative">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label={ARIA}
          className="block h-auto w-full"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {rules.map((y) => (
            <line key={y} x1="0" x2={VIEW_W} y1={y} y2={y} stroke="var(--color-rule)" strokeWidth="1" />
          ))}

          <g data-part="lhs" stroke="var(--color-ink)" strokeWidth="2.9">
            {lhs.strokes.map((s, i) => (
              <path
                key={i}
                d={s.d}
                data-draw=""
                data-glyph={s.glyph}
                data-char={s.char}
                pathLength={1}
                strokeDasharray="1 2"
              />
            ))}
          </g>

          {/* The first attempt: ghost copy underneath, ink on top (the ink is what gets erased). */}
          <g data-ghost="" stroke="var(--color-ghost)" strokeWidth="2.3" strokeDasharray="5 5.5">
            {attempt.strokes.map((s, i) => (
              <path key={i} d={s.d} />
            ))}
          </g>
          <g data-part="attempt" data-attempt-ink="" stroke="var(--color-ink)" strokeWidth="2.9" style={{ opacity: 0 }}>
            {attempt.strokes.map((s, i) => (
              <path
                key={i}
                d={s.d}
                data-draw=""
                data-glyph={s.glyph}
                data-char={s.char}
                pathLength={1}
                strokeDasharray="1 2"
              />
            ))}
          </g>

          <g data-part="rewrite" stroke="var(--color-ink)" strokeWidth="2.9">
            {rewrite.strokes.map((s, i) => (
              <path
                key={i}
                d={s.d}
                data-draw=""
                data-glyph={s.glyph}
                data-char={s.char}
                pathLength={1}
                strokeDasharray="1 2"
              />
            ))}
          </g>
        </svg>

        {/* Same pill as the app's review header. */}
        <p
          data-ghost=""
          aria-hidden="true"
          className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full border border-ghost/30 bg-ghost-soft/90 px-2 py-0.5 text-[11px] text-ghost-strong sm:top-3 sm:right-3 sm:text-xs"
        >
          <svg width="14" height="4" viewBox="0 0 14 4" aria-hidden="true">
            <path d="M1 2h12" stroke="var(--color-ghost)" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
          </svg>
          erased · kept as ghost
        </p>
      </div>

      {/* What Inkling made of it: the moment, on the lecture's timeline. */}
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-line px-3 py-3 sm:px-4">
        <span
          data-pop=""
          className="inline-flex items-center gap-2 rounded-full border border-corrected/35 bg-corrected-soft px-2.5 py-1 text-[13px] text-corrected-strong"
        >
          <span aria-hidden="true" className="size-2 rounded-full bg-corrected" />
          <span>
            <span className="font-medium">Corrected</span> · forgot the inner derivative
          </span>
        </span>

        <span aria-hidden="true" className="flex min-w-[180px] flex-1 items-center gap-2 sm:max-w-[260px]">
          <span className="font-mono text-[11px] text-ink-subtle">00:00</span>
          <span className="relative h-2.5 flex-1 rounded-sm border border-line bg-paper">
            {/* Baseline window, hatched like the app's timeline. */}
            <span
              className="absolute inset-y-0 left-0 w-[22%] border-r border-dashed border-line-strong"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(-45deg, transparent 0 3px, rgb(15 23 42 / .1) 3px 4px)",
              }}
            />
            <span
              data-progress=""
              className="absolute inset-y-0 left-0 w-full origin-left bg-accent/25"
              style={{ transform: "scaleX(0.58)" }}
            />
            <span
              data-pop=""
              className="absolute top-1/2 left-[52%] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-corrected ring-2 ring-paper"
            />
          </span>
          <span className="font-mono text-[11px] text-ink-subtle">06:00</span>
        </span>
      </figcaption>
    </figure>
  );
}
